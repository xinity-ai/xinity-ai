/**
 * Redis discovery and setup, split into planning and apply halves.
 *
 * `planRedis` finds or asks for a connection URL and, when the user opts into
 * setup, plans a Docker Compose stack, all without changing the host.
 * `applyRedisPlan` writes and starts that stack and persists the URL.
 *
 * Native package installs are not supported (the same rule as PostgreSQL):
 * if Docker is absent the environment is reported as unsupported and the user
 * is pointed at the "I have a connection URL" path instead.
 *
 * The stack is one unauthenticated instance. Its port is published on 127.0.0.1
 * only, so reaching it already means having the host, and the official image
 * ships `protected-mode no`, which is what makes that work through a published
 * port. Anyone needing auth, TLS, or a cluster brings their own URL.
 */
import { cancel, isCancel, log, note, select, spinner as clackSpinner, text } from "./clack.ts";
import { bold, cyan, dim } from "picocolors";
import { type Host, readSecrets } from "./host.ts";
import { pass, fail, info, promptOrUndefined, warn } from "./output.ts";
import { parseEnvString } from "./env-file.ts";
import { SECRETS_DIR, ENV_DIR } from "./component-meta.ts";
import { heredoc } from "./service.ts";
import {
  resolveComposeCmd, composeArgs, composeName, stackDir,
  dockerDaemonReady, tcpPortInUse, type ComposeCmd,
} from "./docker-stack.ts";
import type { ConnectionResult } from "./connectivity.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const STACK_DIR = stackDir("redis");
const COMPOSE_PATH = `${STACK_DIR}/docker-compose.yml`;
const CONTAINER_NAME = "xinity-ai-redis";
const VOLUME_NAME = "xinity-redis-data";
const DEFAULT_PORT = 6379;
// Pinned to match the dev compose.yaml and deployment template.
const REDIS_IMAGE = "redis:7-alpine";

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

export function buildRedisUrl(port: number): string {
  return `redis://localhost:${port}`;
}

export function buildComposeFile(port: number): string {
  return [
    "# Managed by `xinity up infra-redis`. This stack is yours: the data lives in",
    "# the named volume below. Edit and `docker compose up -d` to apply, or",
    "# `docker compose down` to stop (add -v to also delete the data).",
    "#",
    "# One unauthenticated instance. The port is published on 127.0.0.1 only, so",
    "# Redis is reachable at localhost but not exposed to the network.",
    "services:",
    "  redis:",
    `    image: ${REDIS_IMAGE}`,
    `    container_name: ${CONTAINER_NAME}`,
    "    restart: unless-stopped",
    '    command: ["redis-server", "--appendonly", "yes"]',
    "    ports:",
    `      - "127.0.0.1:${port}:6379"`,
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

/** Recover the published host port from an existing compose file, falling back to the default. */
export function parsePublishedPort(composeContent: string, fallback: number = DEFAULT_PORT): number {
  const match = composeContent.match(/127\.0\.0\.1:(\d+):6379/);
  return match ? Number(match[1]) : fallback;
}

export type ExistingRedis = {
  volumeExists: boolean;
  containerExists: boolean;
  composeFile: string | null;
};

/** Probe the host for an already-provisioned Redis stack. Read-only. */
export async function inspectExistingRedis(host: Host): Promise<ExistingRedis> {
  const volume = await host.run(["docker", "volume", "inspect", VOLUME_NAME]);
  const container = await host.run([
    "docker", "ps", "-a", "--filter", `name=${CONTAINER_NAME}`, "--format", "{{.Names}}",
  ]);
  return {
    volumeExists: volume.ok,
    containerExists: container.ok && container.output.trim().length > 0,
    composeFile: await host.readFile(COMPOSE_PATH),
  };
}

// ─── Health ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 1000;
const POLL_ATTEMPTS = 30;

/** Poll redis-cli inside the container (the host has no native redis-cli in the Docker model). */
async function waitForRedisReady(host: Host, compose: ComposeCmd): Promise<boolean> {
  const probe = composeArgs(compose, COMPOSE_PATH, "exec", "-T", "redis", "redis-cli", "ping").join(" ");
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const res = await host.withElevation(probe, "Check Redis readiness");
    if (res.success && res.output.includes("PONG")) return true;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return false;
}

// ─── File writing ──────────────────────────────────────────────────────────

function buildWriteFileCommand(path: string, content: string): string {
  return `cat > ${path} ${heredoc("XINITY_REDIS_EOF", content)}`;
}

// ─── Provision via Docker ────────────────────────────────────────────────────

/**
 * A fully-decided provisioning action: everything the apply half needs to
 * bring Redis up without asking anything else.
 */
export type RedisProvision = {
  compose: ComposeCmd;
  port: number;
  url: string;
  /** Present when creating a new stack; absent when restarting an existing one. */
  composeFile?: string;
};

/**
 * Planning half: environment checks and configuration prompts only, nothing
 * on the host changes.
 */
export async function planRedisProvision(host: Host): Promise<RedisProvision | undefined> {
  const compose = await resolveComposeCmd(host);
  if (!compose) {
    warn("Docker", "Docker with Compose is required to provision Redis, and was not found.");
    log.info(
      dim("  This environment is not supported for CLI-managed Redis.\n") +
      dim("  Install Docker (https://docs.docker.com/engine/install/) and re-run,\n") +
      dim("  or re-run and supply the connection URL of an existing Redis instance."),
    );
    return undefined;
  }
  if (compose.docker === "docker" && !(await dockerDaemonReady(host))) {
    warn("Docker", "The Docker CLI is installed but the daemon is not reachable.");
    log.info(
      dim("  Start Docker (e.g. `systemctl start docker`) or ensure your user can\n") +
      dim("  access the Docker socket (docker group), then re-run."),
    );
    return undefined;
  }
  pass("Docker", `Using ${cyan(composeName(compose))}`);

  const existing = await inspectExistingRedis(host);
  if (existing.composeFile) {
    const port = parsePublishedPort(existing.composeFile);
    info("Redis", `Reusing the existing stack in ${STACK_DIR}.`);
    return { compose, port, url: buildRedisUrl(port) };
  }

  const portStr = await promptOrUndefined(text({
    message: "Port to publish on localhost", placeholder: String(DEFAULT_PORT), defaultValue: String(DEFAULT_PORT),
  }));
  if (portStr === undefined) return undefined;
  const port = Number(portStr) || DEFAULT_PORT;

  // Best-effort, non-fatal: a clash here is most often a native Redis the user
  // could instead supply via "I have a connection URL".
  if (await tcpPortInUse(host, port)) {
    warn("Port", `Something is already listening on localhost:${port}. Starting the container will fail if it is still bound.`);
  }

  return { compose, port, url: buildRedisUrl(port), composeFile: buildComposeFile(port) };
}

/** One-line summary of the provisioning action for review lists. */
export function describeRedisProvision(prov: RedisProvision): string {
  return prov.composeFile
    ? `Provision Redis via Docker (${REDIS_IMAGE} on localhost:${prov.port})`
    : `Start the existing Redis Docker stack (localhost:${prov.port})`;
}

/** The exact root shell commands the apply half runs, for the script dump. */
export function buildRedisProvisionCommands(prov: RedisProvision): string[] {
  const up = composeArgs(prov.compose, COMPOSE_PATH, "up", "-d").join(" ");
  if (!prov.composeFile) return [up];
  return [
    `mkdir -p ${STACK_DIR}`,
    buildWriteFileCommand(COMPOSE_PATH, prov.composeFile),
    up,
  ];
}

function reportSuccess(compose: ComposeCmd): void {
  const manageCmd = composeArgs(compose, COMPOSE_PATH).join(" ");
  log.info(
    `This stack is yours to manage. The compose file lives in ${STACK_DIR}:\n` +
    `  data: Docker volume ${cyan(VOLUME_NAME)} (inspect: docker volume inspect ${VOLUME_NAME})\n` +
    `  ${cyan(`${manageCmd} down`)}       (stop and remove the container; data volume is kept)\n` +
    `  ${cyan(`${manageCmd} down -v`)}    (also delete the data volume)`,
  );
}

/** Apply half: write the compose file (new stacks only), start, wait for readiness. */
export async function applyRedisProvision(prov: RedisProvision, host: Host): Promise<boolean> {
  if (prov.composeFile) {
    await host.withElevation(`mkdir -p ${STACK_DIR}`, "Create stack directory");
    const written = await host.withElevation(
      buildWriteFileCommand(COMPOSE_PATH, prov.composeFile),
      "Write compose file",
    );
    if (!written.success) {
      fail("Config", "Failed to write the compose file");
      return false;
    }
    pass("Config", `Wrote ${COMPOSE_PATH}`);
  }

  const upResult = await host.withElevation(
    composeArgs(prov.compose, COMPOSE_PATH, "up", "-d").join(" "),
    "Start Redis container",
  );
  if (!upResult.success) {
    fail("Start", "Failed to start the Redis container");
    return false;
  }

  const spinner = clackSpinner();
  spinner.start("Waiting for Redis to become ready…");
  if (!(await waitForRedisReady(host, prov.compose))) {
    spinner.stop("Timed out");
    fail("Health", "Redis container did not become ready within 30 seconds");
    return false;
  }
  spinner.stop("Redis is ready");
  pass("Health", `Redis reachable at localhost:${prov.port}`);
  reportSuccess(prov.compose);
  return true;
}

// ─── Plan / apply model ─────────────────────────────────────────────────────

export type RedisPlan = {
  url: string;
  /** Store the URL into the secrets dir during apply. */
  persist: boolean;
  provision?: RedisProvision;
};

/** Execute a decided redis plan: provision when planned, then persist the URL. */
export async function applyRedisPlan(plan: RedisPlan, host: Host): Promise<boolean> {
  if (plan.provision && !(await applyRedisProvision(plan.provision, host))) return false;
  if (plan.persist) await persistRedisUrl(host, plan.url);
  return true;
}

/** Review lines for the redis actions in an `up all` plan (empty when nothing will change). */
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

/**
 * Planning half: discover REDIS_URL from stored secrets, environment, or
 * component configs, or guide the user to a URL (optionally planning a Docker
 * stack). Reads and prompts only; `applyRedisPlan` makes the changes.
 *
 * Returns undefined if the user cancelled.
 */
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

/**
 * Prompt for a Redis connection URL and test connectivity, allowing retries.
 */
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

/**
 * Entry point for `xinity up infra-redis`: plan, then immediately apply (or
 * describe, on dry runs). If a working connection already exists, offers to
 * keep it or reconfigure.
 */
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
