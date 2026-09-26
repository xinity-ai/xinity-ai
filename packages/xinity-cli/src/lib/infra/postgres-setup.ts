/**
 * `xinity up infra-postgres`. Docker only, by decision: native package installs
 * are not supported. "Use an existing database" is the migrator's (`xinity up
 * db`), which delegates here only once the user chose to set one up instead.
 */
import { confirm, log, note, password as passwordPrompt, text } from "../core/clack.ts";
import { bold, cyan, dim } from "picocolors";
import type { Host } from "../core/host.ts";
import { pass, info, warn, promptOrUndefined, reportDryRunCommands } from "../core/output.ts";
import type { ComposeCmd } from "./docker-stack.ts";
import {
  type ComposeStack, type ExistingStack,
  stackPaths, requireCompose, inspectStack, parsePublishedPort, promptPublishedPort,
  buildWriteFileCommand, writeStackFile, startStack, composeUpCommand,
  composeBaseCommand, execCommand,
} from "./compose-service.ts";
import { randomToken } from "../core/secrets.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const VOLUME_NAME = "xinity-postgres-data";

const POSTGRES: ComposeStack = {
  name: "postgres",
  displayName: "PostgreSQL",
  containerName: "xinity-ai-postgres",
  image: "postgres:17.4-alpine",
  containerPort: 5432,
  defaultPort: 5432,
  volumeName: VOLUME_NAME,
};

const { dir: STACK_DIR, composePath: COMPOSE_PATH } = stackPaths(POSTGRES);
const ENV_PATH = `${STACK_DIR}/postgres.env`;

export function buildConnectionUrl(opts: {
  user: string;
  password: string;
  db: string;
  port: number;
}): string {
  const user = encodeURIComponent(opts.user);
  const password = encodeURIComponent(opts.password);
  const db = encodeURIComponent(opts.db);
  return `postgresql://${user}:${password}@localhost:${opts.port}/${db}`;
}

export function buildPostgresEnv(opts: { db: string; user: string; password: string }): string {
  return [
    `POSTGRES_DB=${opts.db}`,
    `POSTGRES_USER=${opts.user}`,
    `POSTGRES_PASSWORD=${opts.password}`,
    "",
  ].join("\n");
}

export function buildComposeFile(port: number, envPath: string): string {
  return [
    "# Managed by `xinity up infra-postgres`. This stack is yours: the database",
    "# credentials live in postgres.env (next to this file), data lives in the",
    "# named volume below. Edit and `docker compose up -d` to apply, or",
    "# `docker compose down` to stop (add -v to also delete the database).",
    "#",
    "# The port is published on 127.0.0.1 only, so the database is reachable at",
    "# localhost but not exposed to the network.",
    "services:",
    `  ${POSTGRES.name}:`,
    `    image: ${POSTGRES.image}`,
    `    container_name: ${POSTGRES.containerName}`,
    "    restart: unless-stopped",
    "    env_file:",
    `      - ${envPath}`,
    "    ports:",
    `      - "127.0.0.1:${port}:${POSTGRES.containerPort}"`,
    "    volumes:",
    `      - ${VOLUME_NAME}:/var/lib/postgresql/data`,
    "    healthcheck:",
    '      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER"]',
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

export function parsePostgresEnv(content: string): { db?: string; user?: string; password?: string } {
  const out: { db?: string; user?: string; password?: string } = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === "POSTGRES_DB") out.db = value;
    else if (key === "POSTGRES_USER") out.user = value;
    else if (key === "POSTGRES_PASSWORD") out.password = value;
  }
  return out;
}

function readinessProbe(host: Host, compose: ComposeCmd, user: string): () => Promise<boolean> {
  const probe = execCommand(compose, POSTGRES, "pg_isready", "-U", user);
  return async () => {
    const res = await host.withElevation(probe, "Check PostgreSQL readiness");
    return res.success;
  };
}

// ─── Provision via Docker ────────────────────────────────────────────────────

function reportSuccess(compose: ComposeCmd, connectionUrl: string): void {
  const manageCmd = composeBaseCommand(compose, POSTGRES);
  note(`DB_CONNECTION_URL=${connectionUrl}`, "Use this in your gateway, dashboard, and daemon env files");
  log.info(
    `This stack is yours to manage. Files live in ${STACK_DIR}:\n` +
    `  credentials: ${ENV_PATH} (0600)\n` +
    `  data:        Docker volume ${cyan(VOLUME_NAME)} (inspect: docker volume inspect ${VOLUME_NAME})\n` +
    `  ${cyan(`${manageCmd} down`)}       (stop and remove the container; data volume is kept)\n` +
    `  ${cyan(`${manageCmd} down -v`)}    (also delete the database volume, destroys data)`,
  );
}

export type PostgresProvision = {
  compose: ComposeCmd;
  user: string;
  port: number;
  url: string;
  files?: { envFile: string; composeFile: string };
}

function planReuseExisting(
  compose: ComposeCmd,
  existing: ExistingStack,
  envFile: string | null,
): PostgresProvision | undefined {
  const creds = envFile ? parsePostgresEnv(envFile) : {};
  if (!creds.user || !creds.password || !creds.db) {
    warn("PostgreSQL", `An existing data volume (${VOLUME_NAME}) was found, but its credentials could not be recovered from ${ENV_PATH}.`);
    log.info(
      dim("  The database already holds data and its password cannot be changed by re-running setup.\n") +
      dim("  Either choose \"use an existing database\" and supply its connection URL, or, to start\n") +
      dim(`  fresh (DESTROYS DATA), run: ${composeBaseCommand(compose, POSTGRES)} down -v`),
    );
    return undefined;
  }

  const port = existing.composeFile ? parsePublishedPort(existing.composeFile, POSTGRES) : POSTGRES.defaultPort;
  const connectionUrl = buildConnectionUrl({ user: creds.user, password: creds.password, db: creds.db, port });
  info("PostgreSQL", `Reusing the existing database (credentials from ${ENV_PATH}); not regenerating.`);
  return { compose, user: creds.user, port, url: connectionUrl };
}

export async function planPostgresProvision(host: Host): Promise<PostgresProvision | undefined> {
  const compose = await requireCompose(host, POSTGRES, {
    requiredTo: "provision a database",
    fallbackHint: "or re-run and choose \"use an existing database\" with a connection URL.",
  });
  if (!compose) return undefined;

  const existing = await inspectStack(host, POSTGRES);
  // The image applies POSTGRES_* on first init only, so an existing volume has
  // frozen credentials: regenerating here would hand out a password it never took.
  if (existing.volumeExists) {
    return planReuseExisting(compose, existing, await host.readFile(ENV_PATH));
  }

  log.step(bold("Configure the new database"));

  const db = await promptOrUndefined(text({
    message: "Database name", placeholder: "xinity", defaultValue: "xinity",
  }));
  if (db === undefined) return undefined;

  const user = await promptOrUndefined(text({
    message: "Database user", placeholder: "xinity", defaultValue: "xinity",
  }));
  if (user === undefined) return undefined;

  const useGenerated = await promptOrUndefined(confirm({
    message: "Generate a random password?", initialValue: true,
  }));
  if (useGenerated === undefined) return undefined;

  let password: string;
  if (useGenerated) {
    password = randomToken(24);
    info("Password", `Generated: ${cyan(password)}`);
  } else {
    const pw = await promptOrUndefined(passwordPrompt({
      message: "Database password",
      validate: (val) => (!val || val.length < 4 ? "Password must be at least 4 characters" : undefined),
    }));
    if (pw === undefined) return undefined;
    password = pw;
  }

  const port = await promptPublishedPort(host, POSTGRES);
  if (port === undefined) return undefined;

  return {
    compose,
    user,
    port,
    url: buildConnectionUrl({ user, password, db, port }),
    files: {
      envFile: buildPostgresEnv({ db, user, password }),
      composeFile: buildComposeFile(port, ENV_PATH),
    },
  };
}

export function describePostgresProvision(prov: PostgresProvision): string {
  return prov.files
    ? `Provision PostgreSQL via Docker (${POSTGRES.image} on localhost:${prov.port})`
    : `Start the existing PostgreSQL Docker stack (localhost:${prov.port})`;
}

export function buildPostgresProvisionCommands(prov: PostgresProvision): string[] {
  const up = composeUpCommand(prov.compose, POSTGRES);
  if (!prov.files) return [up];
  return [
    `mkdir -p ${STACK_DIR}`,
    buildWriteFileCommand(POSTGRES, ENV_PATH, prov.files.envFile, "600"),
    buildWriteFileCommand(POSTGRES, COMPOSE_PATH, prov.files.composeFile),
    up,
  ];
}

export async function applyPostgresProvision(prov: PostgresProvision, host: Host): Promise<boolean> {
  if (prov.files) {
    await host.withElevation(`mkdir -p ${STACK_DIR}`, "Create stack directory");
    if (!(await writeStackFile(host, POSTGRES, ENV_PATH, prov.files.envFile, "database env file", "600"))) return false;
    if (!(await writeStackFile(host, POSTGRES, COMPOSE_PATH, prov.files.composeFile, "compose file"))) return false;
    pass("Config", `Wrote ${COMPOSE_PATH} and ${ENV_PATH}`);
  }

  const started = await startStack(host, prov.compose, POSTGRES, {
    reachableAt: `localhost:${prov.port}`,
    ready: readinessProbe(host, prov.compose, prov.user),
  });
  if (!started) return false;

  reportSuccess(prov.compose, prov.url);
  return true;
}

// ─── Main entry point ───────────────────────────────────────────────────────

export async function postgresSetup(host: Host, dryRun: boolean): Promise<string | undefined> {
  log.step(bold("PostgreSQL setup"));
  const prov = await planPostgresProvision(host);
  if (!prov) return undefined;

  if (dryRun) {
    reportDryRunCommands(buildPostgresProvisionCommands(prov));
    note(`DB_CONNECTION_URL=${prov.url}`, prov.files ? "Connection URL (not yet created)" : "Existing connection URL");
    return prov.url;
  }

  return (await applyPostgresProvision(prov, host)) ? prov.url : undefined;
}
