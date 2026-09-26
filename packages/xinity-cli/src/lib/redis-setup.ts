/**
 * `xinity up infra-redis`. Docker only, by the same rule as PostgreSQL: without
 * it the user is pointed at the "I have a connection URL" path instead.
 *
 * The provisioned stack is one instance on 127.0.0.1 whose generated password
 * the compose file is the only record of. Anyone needing TLS or a cluster
 * brings their own URL, so those cases are deliberately absent here.
 */
import { cancel, isCancel, log, note, select, spinner as clackSpinner, text } from "./clack.ts";
import { bold, cyan, dim } from "picocolors";
import { type Host, readSecrets } from "./host.ts";
import { pass, info, promptOrUndefined, warn } from "./output.ts";
import { parseEnvString } from "./env-file.ts";
import { randomToken } from "./secrets.ts";
import { SECRETS_DIR, ENV_DIR } from "./component-meta.ts";
import { tcpPortInUse, type ComposeCmd } from "./docker-stack.ts";
import {
  type ComposeStack,
  stackPaths, requireCompose, inspectStack, parsePublishedPort,
  buildWriteFileCommand, writeStackFile, startStack, composeUpCommand,
  composeBaseCommand, execCommand,
} from "./compose-service.ts";
import type { ConnectionResult } from "./connectivity.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const VOLUME_NAME = "xinity-redis-data";

// Image pinned to match the dev compose.yaml and deployment template.
const REDIS: ComposeStack = {
  name: "redis",
  displayName: "Redis",
  containerName: "xinity-ai-redis",
  image: "redis:7-alpine",
  containerPort: 6379,
  defaultPort: 6379,
  volumeName: VOLUME_NAME,
};

const { dir: STACK_DIR, composePath: COMPOSE_PATH } = stackPaths(REDIS);

// ─── Helpers ────────────────────────────────────────────────────────────────

async function testRedisWithSpinner(url: string, host: Host): Promise<ConnectionResult> {
  const { testRedisConnection } = await import("./connectivity.ts");
  const spinner = clackSpinner();
  spinner.start("Testing Redis connection…");
  const result = await testRedisConnection(url, host);
  spinner.stop(result.success ? "Redis connection successful" : "Redis connection failed");
  if (!result.success && result.error) {
    log.error(dim(result.error));
  }
  return result;
}

export function buildRedisUrl(port: number, password?: string): string {
  return password
    ? `redis://:${encodeURIComponent(password)}@localhost:${port}`
    : `redis://localhost:${port}`;
}

export function buildComposeFile(port: number, password: string): string {
  return [
    "# Managed by `xinity up infra-redis`. This stack is yours: the data lives in",
    "# the named volume below. Edit and `docker compose up -d` to apply, or",
    "# `docker compose down` to stop (add -v to also delete the data).",
    "#",
    "# Change the password below and re-run `xinity up infra-redis` so the stored URL follows.",
    "services:",
    `  ${REDIS.name}:`,
    `    image: ${REDIS.image}`,
    `    container_name: ${REDIS.containerName}`,
    "    restart: unless-stopped",
    `    command: ["redis-server", "--appendonly", "yes", "--requirepass", "${password}"]`,
    "    environment:",
    `      REDISCLI_AUTH: "${password}"`,
    "    ports:",
    `      - "127.0.0.1:${port}:${REDIS.containerPort}"`,
    "    volumes:",
    `      - ${VOLUME_NAME}:/data`,
    "    healthcheck:",
    '      test: ["CMD", "redis-cli", "ping"]',
    "      interval: 10s",
    "      timeout: 5s",
    "      retries: 5",
    "",
    "volumes:",
    `  ${VOLUME_NAME}:`,
    "",
  ].join("\n");
}

// ─── Pre-existing state ──────────────────────────────────────────────────────

export function parseRequirePass(composeContent: string): string | undefined {
  return composeContent.match(/"--requirepass", "([^"]+)"/)?.[1];
}

function readinessProbe(host: Host, compose: ComposeCmd): () => Promise<boolean> {
  const probe = execCommand(compose, REDIS, "redis-cli", "ping");
  return async () => {
    const res = await host.withElevation(probe, "Check Redis readiness");
    return res.success && res.output.includes("PONG");
  };
}

// ─── Provision via Docker ────────────────────────────────────────────────────

export type RedisProvision = {
  compose: ComposeCmd;
  port: number;
  url: string;
  composeFile?: string;
}

export async function planRedisProvision(host: Host): Promise<RedisProvision | undefined> {
  const compose = await requireCompose(host, REDIS, {
    requiredTo: "provision Redis",
    fallbackHint: "or re-run and supply the connection URL of an existing Redis instance.",
  });
  if (!compose) return undefined;

  const existing = await inspectStack(host, REDIS);
  if (existing.composeFile) {
    const port = parsePublishedPort(existing.composeFile, REDIS);
    info("Redis", `Reusing the existing stack in ${STACK_DIR}.`);
    return { compose, port, url: buildRedisUrl(port, parseRequirePass(existing.composeFile)) };
  }

  const portStr = await promptOrUndefined(text({
    message: "Port to publish on localhost",
    placeholder: String(REDIS.defaultPort),
    defaultValue: String(REDIS.defaultPort),
  }));
  if (portStr === undefined) return undefined;
  const port = Number(portStr) || REDIS.defaultPort;

  // Best-effort, non-fatal: a clash here is most often a native Redis the user
  // could instead supply via "I have a connection URL".
  if (await tcpPortInUse(host, port)) {
    warn("Port", `Something is already listening on localhost:${port}. Starting the container will fail if it is still bound.`);
  }

  const password = randomToken(32);
  return { compose, port, url: buildRedisUrl(port, password), composeFile: buildComposeFile(port, password) };
}

export function describeRedisProvision(prov: RedisProvision): string {
  return prov.composeFile
    ? `Provision Redis via Docker (${REDIS.image} on localhost:${prov.port})`
    : `Start the existing Redis Docker stack (localhost:${prov.port})`;
}

export function buildRedisProvisionCommands(prov: RedisProvision): string[] {
  const up = composeUpCommand(prov.compose, REDIS);
  if (!prov.composeFile) return [up];
  return [
    `mkdir -p ${STACK_DIR}`,
    buildWriteFileCommand(REDIS, COMPOSE_PATH, prov.composeFile),
    up,
  ];
}

function reportSuccess(compose: ComposeCmd): void {
  const manageCmd = composeBaseCommand(compose, REDIS);
  log.info(
    `This stack is yours to manage. The compose file lives in ${STACK_DIR}:\n` +
    `  data: Docker volume ${cyan(VOLUME_NAME)} (inspect: docker volume inspect ${VOLUME_NAME})\n` +
    `  ${cyan(`${manageCmd} down`)}       (stop and remove the container; data volume is kept)\n` +
    `  ${cyan(`${manageCmd} down -v`)}    (also delete the data volume)`,
  );
}

export async function applyRedisProvision(prov: RedisProvision, host: Host): Promise<boolean> {
  if (prov.composeFile) {
    await host.withElevation(`mkdir -p ${STACK_DIR}`, "Create stack directory");
    if (!(await writeStackFile(host, REDIS, COMPOSE_PATH, prov.composeFile, "compose file"))) return false;
    pass("Config", `Wrote ${COMPOSE_PATH}`);
  }

  const started = await startStack(host, prov.compose, REDIS, {
    reachableAt: `localhost:${prov.port}`,
    ready: readinessProbe(host, prov.compose),
  });
  if (!started) return false;

  reportSuccess(prov.compose);
  return true;
}

// ─── Plan / apply model ─────────────────────────────────────────────────────

export type RedisPlan = {
  url: string;
  persist: boolean;
  provision?: RedisProvision;
};

export async function applyRedisPlan(plan: RedisPlan, host: Host): Promise<boolean> {
  if (plan.provision && !(await applyRedisProvision(plan.provision, host))) return false;
  if (plan.persist) await persistRedisUrl(host, plan.url);
  return true;
}

export function describeRedisPlan(plan: RedisPlan): string[] {
  if (!plan.provision && !plan.persist) return [];
  const head = plan.provision ? describeRedisProvision(plan.provision) : "Store the Redis connection URL";
  return plan.persist ? [head, `  store REDIS_URL in ${SECRETS_DIR}`] : [head];
}

// ─── Main entry point ───────────────────────────────────────────────────────

function redactRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "****";
    return parsed.toString();
  } catch {
    return url.replace(/:([^@]+)@/, ":****@");
  }
}

async function persistRedisUrl(host: Host, url: string): Promise<void> {
  // Only write if the value actually changed.
  const existing = await readSecrets(host, SECRETS_DIR, ["REDIS_URL"], "Read stored Redis URL");
  if (existing.secrets.REDIS_URL === url) return;

  const escaped = url.replace(/'/g, "'\\''");
  await host.withElevation(
    `mkdir -p '${SECRETS_DIR}' && chmod 700 '${SECRETS_DIR}'` +
    ` && printf '%s' '${escaped}' > '${SECRETS_DIR}/REDIS_URL' && chmod 600 '${SECRETS_DIR}/REDIS_URL'`,
    "Store Redis connection URL",
  );
}

export async function planRedis(host: Host): Promise<RedisPlan | undefined> {
  // 1. Check stored secret
  const stored = await readSecrets(host, SECRETS_DIR, ["REDIS_URL"], "Read stored Redis URL");
  if (stored.secrets.REDIS_URL) {
    const url = stored.secrets.REDIS_URL;
    info("Redis connection", `Found stored URL: ${redactRedisUrl(url)}`);
    const result = await testRedisWithSpinner(url, host);
    if (result.success) {
      return { url, persist: false };
    }

    // Stored URL is stale, offer to reconfigure
    const action = await select({
      message: "Stored Redis URL failed connectivity test.",
      options: [
        { value: "reenter", label: "Enter a new URL" },
        { value: "setup", label: "Set up a new Redis instance" },
        { value: "keep", label: "Use the stored URL anyway" },
      ],
    });
    if (isCancel(action)) { cancel("Cancelled."); return undefined; }
    if (action === "keep") return { url, persist: false };
    if (action === "setup") return planRedisSetup(host);
    const newUrl = await promptAndValidateRedisUrl(host);
    return newUrl ? { url: newUrl, persist: true } : undefined;
  }

  // 2. Check environment variable
  if (process.env.REDIS_URL) {
    info("Redis connection", "Using REDIS_URL from environment");
    return { url: process.env.REDIS_URL, persist: true };
  }

  // 3. Check installed component env files on the target host
  for (const component of ["gateway", "dashboard", "daemon"]) {
    const envPath = `${ENV_DIR}/${component}.env`;
    if (await host.fileExists(envPath)) {
      const content = await host.readFile(envPath);
      if (content) {
        const env = parseEnvString(content);
        if (env.REDIS_URL) {
          info("Redis connection", `Found in ${component}.env`);
          return { url: env.REDIS_URL, persist: true };
        }
      }
    }
  }

  // 4. No existing connection found, ask user how to proceed
  const choice = await select({
    message: "No existing Redis connection found. Do you already have a Redis instance?",
    options: [
      {
        value: "existing",
        label: "Yes, I have a connection URL",
        hint: "enter your Redis connection string",
      },
      {
        value: "setup",
        label: "No, help me set one up",
        hint: "run Redis as a Docker container",
      },
    ],
  });

  if (isCancel(choice)) {
    cancel("Cancelled.");
    return undefined;
  }

  if (choice === "setup") return planRedisSetup(host);

  // Existing instance, prompt for URL then validate connectivity
  const url = await promptAndValidateRedisUrl(host);
  return url ? { url, persist: true } : undefined;
}

async function promptAndValidateRedisUrl(host: Host): Promise<string | undefined> {
  while (true) {
    const value = await text({
      message: "REDIS_URL",
      placeholder: "redis://localhost:6379",
      validate: (val) => {
        if (!val) return "A connection URL is required";
        if (!val.startsWith("redis")) return "Must be a Redis connection URL";
        return undefined;
      },
    });
    if (isCancel(value)) {
      cancel("Cancelled.");
      return undefined;
    }

    const result = await testRedisWithSpinner(value, host);
    if (result.success) {
      return value;
    }

    const action = await select({
      message: "Could not connect to Redis.",
      options: [
        { value: "retry", label: "Enter a different URL" },
        { value: "proceed", label: "Use this URL anyway" },
      ],
    });
    if (isCancel(action) || action === "proceed") return value;
  }
}

async function planRedisSetup(host: Host): Promise<RedisPlan | undefined> {
  log.step(bold("Redis setup"));
  const provision = await planRedisProvision(host);
  return provision ? { url: provision.url, persist: true, provision } : undefined;
}

function describeRedisPlanDryRun(plan: RedisPlan): void {
  if (plan.provision) {
    for (const cmd of buildRedisProvisionCommands(plan.provision)) {
      info("Dry run", `Would run: ${dim(cmd.split("\n")[0] ?? cmd)}`);
    }
  }
  if (plan.persist) {
    info("Dry run", `Would store REDIS_URL in ${SECRETS_DIR}`);
  }
}

export async function infraRedis(host: Host, dryRun: boolean): Promise<string | undefined> {
  let plan: RedisPlan | undefined;

  const stored = await readSecrets(host, SECRETS_DIR, ["REDIS_URL"], "Read stored Redis URL");
  const storedUrl = stored.secrets.REDIS_URL;
  if (storedUrl && (await testRedisWithSpinner(storedUrl, host)).success) {
    info("Redis connection", `Current: ${redactRedisUrl(storedUrl)}`);
    const action = await select({
      message: "Redis is configured and reachable.",
      options: [
        { value: "keep", label: "Keep current configuration" },
        { value: "reenter", label: "Enter a different URL" },
        { value: "setup", label: "Set up a new Redis instance" },
      ],
    });
    if (isCancel(action) || action === "keep") return storedUrl;
    if (action === "reenter") {
      const newUrl = await promptAndValidateRedisUrl(host);
      plan = newUrl ? { url: newUrl, persist: true } : undefined;
    } else {
      plan = await planRedisSetup(host);
    }
  } else {
    // No stored URL, or stored but unreachable: planRedis owns the stale-URL flow.
    plan = await planRedis(host);
  }

  if (!plan) return undefined;
  if (dryRun) {
    describeRedisPlanDryRun(plan);
    note(`REDIS_URL=${plan.url}`, plan.provision?.composeFile ? "Connection URL (not yet created)" : "Connection URL");
    return plan.url;
  }
  return (await applyRedisPlan(plan, host)) ? plan.url : undefined;
}
