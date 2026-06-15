/**
 * `xinity up infra-postgres`: provision a new PostgreSQL database via Docker.
 *
 * Native package installs are not supported; if Docker is absent the environment
 * is reported as unsupported. The "use an existing database" case is intentionally
 * absent here, the migrator (`xinity up db`) owns it and only delegates to this
 * assistant when the user chose to set one up.
 */
import { randomBytes } from "crypto";
import * as p from "./clack.ts";
import pc from "picocolors";
import { type Host } from "./host.ts";
import { pass, fail, info, warn, promptOrUndefined } from "./output.ts";
import {
  resolveComposeCmd, composeArgs, composeName, stackDir,
  dockerDaemonReady, tcpPortInUse, type ComposeCmd,
} from "./docker-stack.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const STACK_DIR = stackDir("postgres");
const COMPOSE_PATH = `${STACK_DIR}/docker-compose.yml`;
const ENV_PATH = `${STACK_DIR}/postgres.env`;
const CONTAINER_NAME = "xinity-ai-postgres";
const VOLUME_NAME = "xinity-postgres-data";
const DEFAULT_PORT = 5432;
// Pinned to match the dev compose.yaml and deployment template.
const POSTGRES_IMAGE = "postgres:17.4-alpine";

// ─── Helpers ────────────────────────────────────────────────────────────────

function generatePassword(length = 24): string {
  return randomBytes(length).toString("base64url").slice(0, length);
}

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

/** The 0600 env file the compose stack reads POSTGRES_* from. Keeps the secret out of compose.yml. */
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
    "  postgres:",
    `    image: ${POSTGRES_IMAGE}`,
    `    container_name: ${CONTAINER_NAME}`,
    "    restart: unless-stopped",
    "    env_file:",
    `      - ${envPath}`,
    "    ports:",
    `      - "127.0.0.1:${port}:5432"`,
    "    volumes:",
    "      - xinity-postgres-data:/var/lib/postgresql/data",
    "    healthcheck:",
    '      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER"]',
    "      interval: 10s",
    "      timeout: 5s",
    "      retries: 5",
    "",
    "volumes:",
    "  xinity-postgres-data:",
    "",
  ].join("\n");
}

// ─── Pre-existing state ──────────────────────────────────────────────────────

/** Parse a postgres.env file back into its POSTGRES_* values. */
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

/** Recover the published host port from an existing compose file, falling back to the default. */
export function parsePublishedPort(composeContent: string, fallback: number = DEFAULT_PORT): number {
  const match = composeContent.match(/127\.0\.0\.1:(\d+):5432/);
  return match ? Number(match[1]) : fallback;
}

export type ExistingPostgres = {
  /** Data volume exists, so the cluster is already initialized and its credentials are fixed. */
  volumeExists: boolean;
  containerExists: boolean;
  envFile: string | null;
  composeFile: string | null;
};

/** Probe the host for an already-provisioned Postgres stack. Read-only. */
export async function inspectExistingPostgres(host: Host): Promise<ExistingPostgres> {
  const volume = await host.run(["docker", "volume", "inspect", VOLUME_NAME]);
  const container = await host.run([
    "docker", "ps", "-a", "--filter", `name=${CONTAINER_NAME}`, "--format", "{{.Names}}",
  ]);
  return {
    volumeExists: volume.ok,
    containerExists: container.ok && container.output.trim().length > 0,
    envFile: await host.readFile(ENV_PATH),
    composeFile: await host.readFile(COMPOSE_PATH),
  };
}

// ─── Health ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 1000;
const POLL_ATTEMPTS = 30;

/** Poll pg_isready inside the container (the host has no native psql in the Docker model). */
async function waitForPostgresReady(
  host: Host,
  compose: ComposeCmd,
  user: string,
): Promise<boolean> {
  const args = composeArgs(compose, COMPOSE_PATH, "exec", "-T", "postgres", "pg_isready", "-U", user);
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const res = await host.withElevation(args.join(" "), "Check PostgreSQL readiness");
    if (res.success) return true;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return false;
}

// ─── File writing ──────────────────────────────────────────────────────────

async function writeFile(
  host: Host,
  path: string,
  content: string,
  label: string,
  mode?: string,
): Promise<boolean> {
  const chmod = mode ? `\nchmod ${mode} ${path}` : "";
  const result = await host.withElevation(
    `cat > ${path} << 'XINITY_PG_EOF'\n${content}\nXINITY_PG_EOF${chmod}`,
    `Write ${label}`,
  );
  if (!result.success && !result.skipped) {
    fail("Config", `Failed to write ${label}`);
    return false;
  }
  return true;
}

// ─── Provision via Docker ────────────────────────────────────────────────────

/** Start (or ensure running) the stack and wait for readiness. Returns false on failure. */
async function startAndWait(host: Host, compose: ComposeCmd, user: string, port: number): Promise<boolean> {
  const upResult = await host.withElevation(
    composeArgs(compose, COMPOSE_PATH, "up", "-d").join(" "),
    "Start PostgreSQL container",
  );
  if (!upResult.success && !upResult.skipped) {
    fail("Start", "Failed to start the PostgreSQL container");
    return false;
  }

  const spinner = p.spinner();
  spinner.start("Waiting for PostgreSQL to become ready…");
  const ready = await waitForPostgresReady(host, compose, user);
  if (ready) {
    spinner.stop("PostgreSQL is ready");
    pass("Health", `PostgreSQL reachable at localhost:${port}`);
    return true;
  }
  spinner.stop("Timed out");
  fail("Health", "PostgreSQL container did not become ready within 30 seconds");
  return false;
}

function reportSuccess(compose: ComposeCmd, connectionUrl: string): void {
  const manageCmd = composeArgs(compose, COMPOSE_PATH).join(" ");
  p.note(`DB_CONNECTION_URL=${connectionUrl}`, "Use this in your gateway, dashboard, and daemon env files");
  p.log.info(
    `This stack is yours to manage. Files live in ${STACK_DIR}:\n` +
    `  credentials: ${ENV_PATH} (0600)\n` +
    `  data:        Docker volume ${pc.cyan(VOLUME_NAME)} (inspect: docker volume inspect ${VOLUME_NAME})\n` +
    `  ${pc.cyan(`${manageCmd} down`)}       (stop and remove the container; data volume is kept)\n` +
    `  ${pc.cyan(`${manageCmd} down -v`)}    (also delete the database volume — destroys data)`,
  );
}

/**
 * Handle a stack whose data volume already exists. The Postgres image only
 * applies POSTGRES_* on first init, so we must NOT regenerate credentials: we
 * reuse the existing env file, or refuse if we can't recover the password.
 */
async function reuseExisting(
  host: Host,
  compose: ComposeCmd,
  existing: ExistingPostgres,
  dryRun: boolean,
): Promise<string | undefined> {
  const creds = existing.envFile ? parsePostgresEnv(existing.envFile) : {};
  if (!creds.user || !creds.password || !creds.db) {
    warn("PostgreSQL", `An existing data volume (${VOLUME_NAME}) was found, but its credentials could not be recovered from ${ENV_PATH}.`);
    p.log.info(
      pc.dim("  The database already holds data and its password cannot be changed by re-running setup.\n") +
      pc.dim("  Either choose \"use an existing database\" and supply its connection URL, or, to start\n") +
      pc.dim(`  fresh (DESTROYS DATA), run: ${composeArgs(compose, COMPOSE_PATH, "down", "-v").join(" ")}`),
    );
    return undefined;
  }

  const port = existing.composeFile ? parsePublishedPort(existing.composeFile) : DEFAULT_PORT;
  const connectionUrl = buildConnectionUrl({ user: creds.user, password: creds.password, db: creds.db, port });
  info("PostgreSQL", `Reusing the existing database (credentials from ${ENV_PATH}); not regenerating.`);

  if (dryRun) {
    info("Dry run", `Would ensure the existing stack is running: ${pc.dim(composeArgs(compose, COMPOSE_PATH, "up", "-d").join(" "))}`);
    p.note(`DB_CONNECTION_URL=${connectionUrl}`, "Existing connection URL");
    return connectionUrl;
  }

  if (!(await startAndWait(host, compose, creds.user, port))) return undefined;
  reportSuccess(compose, connectionUrl);
  return connectionUrl;
}

async function provisionWithDocker(host: Host, dryRun: boolean): Promise<string | undefined> {
  const compose = await resolveComposeCmd(host);
  if (!compose) {
    warn("Docker", "Docker with Compose is required to provision a database, and was not found.");
    p.log.info(
      pc.dim("  This environment is not supported for CLI-managed PostgreSQL.\n") +
      pc.dim("  Install Docker (https://docs.docker.com/engine/install/) and re-run,\n") +
      pc.dim("  or re-run and choose \"use an existing database\" with a connection URL."),
    );
    return undefined;
  }
  if (compose.docker === "docker" && !(await dockerDaemonReady(host))) {
    warn("Docker", "The Docker CLI is installed but the daemon is not reachable.");
    p.log.info(
      pc.dim("  Start Docker (e.g. `systemctl start docker`) or ensure your user can\n") +
      pc.dim("  access the Docker socket (docker group), then re-run."),
    );
    return undefined;
  }
  pass("Docker", `Using ${pc.cyan(composeName(compose))}`);

  // Re-running over an already-initialized cluster cannot change its credentials,
  // so reuse rather than silently hand out a password the database never adopted.
  const existing = await inspectExistingPostgres(host);
  if (existing.volumeExists) {
    return reuseExisting(host, compose, existing, dryRun);
  }

  p.log.step(pc.bold("Configure the new database"));

  const db = await promptOrUndefined(p.text({
    message: "Database name", placeholder: "xinity", defaultValue: "xinity",
  }));
  if (db === undefined) return undefined;

  const user = await promptOrUndefined(p.text({
    message: "Database user", placeholder: "xinity", defaultValue: "xinity",
  }));
  if (user === undefined) return undefined;

  const useGenerated = await promptOrUndefined(p.confirm({
    message: "Generate a random password?", initialValue: true,
  }));
  if (useGenerated === undefined) return undefined;

  let password: string;
  if (useGenerated) {
    password = generatePassword();
    info("Password", `Generated: ${pc.cyan(password)}`);
  } else {
    const pw = await promptOrUndefined(p.password({
      message: "Database password",
      validate: (val) => (!val || val.length < 4 ? "Password must be at least 4 characters" : undefined),
    }));
    if (pw === undefined) return undefined;
    password = pw;
  }

  const portStr = await promptOrUndefined(p.text({
    message: "Port to publish on localhost", placeholder: String(DEFAULT_PORT), defaultValue: String(DEFAULT_PORT),
  }));
  if (portStr === undefined) return undefined;
  const port = Number(portStr) || DEFAULT_PORT;

  // Best-effort, non-fatal: a clash here is most often a native Postgres the
  // user could instead supply via "use an existing database".
  if (await tcpPortInUse(host, port)) {
    warn("Port", `Something is already listening on localhost:${port}. Starting the container will fail if it is still bound.`);
  }

  const connectionUrl = buildConnectionUrl({ user, password, db, port });
  const envFile = buildPostgresEnv({ db, user, password });
  const composeFile = buildComposeFile(port, ENV_PATH);

  if (dryRun) {
    info("Dry run", `Would write ${ENV_PATH} (0600) and ${COMPOSE_PATH}`);
    info("Dry run", `Would run: ${pc.dim(composeArgs(compose, COMPOSE_PATH, "up", "-d").join(" "))}`);
    p.note(`DB_CONNECTION_URL=${connectionUrl}`, "Connection URL (not yet created)");
    return connectionUrl;
  }

  await host.withElevation(`mkdir -p ${STACK_DIR}`, "Create stack directory");
  if (!(await writeFile(host, ENV_PATH, envFile, "database env file", "600"))) return undefined;
  if (!(await writeFile(host, COMPOSE_PATH, composeFile, "compose file"))) return undefined;
  pass("Config", `Wrote ${COMPOSE_PATH} and ${ENV_PATH}`);

  if (!(await startAndWait(host, compose, user, port))) return undefined;
  reportSuccess(compose, connectionUrl);
  return connectionUrl;
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Provision a new PostgreSQL database via Docker.
 *
 * Returns the connection URL on success, or undefined if the user cancelled or
 * the environment is unsupported. The existing-database case is handled upstream
 * by the migrator (see the module comment), not here.
 */
export async function postgresSetup(host: Host, dryRun: boolean): Promise<string | undefined> {
  p.log.step(pc.bold("PostgreSQL setup"));
  return provisionWithDocker(host, dryRun);
}
