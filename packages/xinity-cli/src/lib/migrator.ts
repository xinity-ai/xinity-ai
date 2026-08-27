/**
 * Database migration runner.
 *
 * `discoverConnectionUrl` is the planning-phase half: find or ask for the
 * DB_CONNECTION_URL without changing anything. `runMigrations` is the apply
 * half: resolve a migration folder (a GitHub release tarball, or the local
 * repository for `local:` targets) and apply pending migrations via
 * drizzle-orm's programmatic migrator.
 */
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { cancel, confirm, isCancel, log, select, spinner as clackSpinner, text } from "./clack.ts";
import { bold, cyan, dim } from "picocolors";

import { fetchRelease, pickReleaseAsset, type Release } from "./github.ts";
import { downloadAndVerify } from "./install-download.ts";
import { localVersionString } from "./local-build.ts";
import { runSteps } from "./step-runner.ts";
import { parseEnvString } from "./env-file.ts";
import { fail, pass, info, warn } from "./output.ts";
import { planPostgresProvision, type PostgresProvision } from "./postgres-setup.ts";
import { type Host, localRun } from "./host.ts";
import { readManifest, saveDbHint, updateManifestEntry } from "./manifest.ts";
import { ENV_DIR, SECRETS_DIR } from "./component-meta.ts";

const DB_SECRET_PATH = `${SECRETS_DIR}/DB_CONNECTION_URL`;

/**
 * Return a safe display string for a postgres URL: user@host:port/dbname.
 * Never includes the password.
 */
export function dbHint(url: string): string {
  try {
    const u = new URL(url);
    const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    const db = u.pathname.replace(/^\//, "") || "(default)";
    return u.username ? `${u.username}@${host}/${db}` : `${host}/${db}`;
  } catch {
    return "(invalid URL)";
  }
}

/** The one wording every plan review uses for the migration step. */
export function describeMigrationStep(targetVersion: string, connectionUrl: string): string {
  const source = targetVersion.startsWith("local:")
    ? `local repository ${targetVersion.slice(6)}`
    : `release ${targetVersion}`;
  return `Apply database migrations from ${source} to ${dbHint(connectionUrl)}`;
}

/** Script-dump stand-in for migrations, which run through drizzle and have no bash equivalent. */
export function migrationScriptComment(cliCommand: string): string[] {
  return [
    "# Database migrations run inside the CLI (drizzle migrator, no bash equivalent):",
    `#   ${cliCommand}`,
    "",
  ];
}

/**
 * Offer a discovered candidate URL to the user, showing only the safe hint.
 * Returns the full URL if accepted, null if declined, undefined if cancelled.
 */
async function confirmCandidate(
  label: string,
  url: string,
): Promise<string | null | undefined> {
  const use = await confirm({
    message: `DB connection found ${label} (${dbHint(url)}). Use this?`,
    initialValue: true,
  });
  if (isCancel(use)) { cancel("Cancelled."); return undefined; }
  return use ? url : null;
}

/** The database half of a plan: the URL to use, plus provisioning when the user chose setup. */
export type DbPlan = {
  connectionUrl: string;
  provision?: PostgresProvision;
}

/**
 * Planning-phase discovery of DB_CONNECTION_URL from environment, stored
 * secret, or installed component configs. Confirms each candidate before
 * returning it. If nothing usable is found, either takes a URL from the user
 * or plans a new PostgreSQL stack. Reads and prompts only; provisioning and
 * migrations are separate apply steps.
 */
export async function discoverConnectionUrl(host: Host): Promise<DbPlan | undefined> {
  let foundCandidate = false;

  // 1. Previously stored secret on the target host (written by a prior migration run).
  //    The manifest carries only a safe hint (user@host/db, no password). Confirm
  //    based on that - only elevate to read the actual secret after the user says yes.
  const manifest = await readManifest(host);
  if (manifest.db?.hint) {
    foundCandidate = true;
    const use = await confirm({
      message: `DB connection found in stored secret (${manifest.db.hint}). Use this?`,
      initialValue: true,
    });
    if (isCancel(use)) { cancel("Cancelled."); return undefined; }
    if (use) {
      // Append `; echo` so the output ends with a newline, keeping the ::exit:: marker
      // on its own line regardless of whether the secret file has a trailing newline.
      const readResult = await host.withElevation(
        `cat '${DB_SECRET_PATH}'; echo`,
        "Read stored DB connection URL",
      );
      if (readResult.success && readResult.output.trim()) {
        return { connectionUrl: readResult.output.trim() };
      }
      warn("DB secret", "Could not read stored secret - please provide the URL manually");
      // Fall through to manual entry
    }
  }

  // 2. Environment variable - may point to a local dev DB unrelated to the host.
  if (process.env.DB_CONNECTION_URL) {
    foundCandidate = true;
    const result = await confirmCandidate("in environment", process.env.DB_CONNECTION_URL);
    if (result === undefined) return undefined;
    if (result) return { connectionUrl: result };
  }

  // 3. Component env files on the target host.
  for (const component of ["gateway", "dashboard", "daemon", "tether"]) {
    const envPath = `${ENV_DIR}/${component}.env`;
    if (await host.fileExists(envPath)) {
      const content = await host.readFile(envPath);
      if (content) {
        const env = parseEnvString(content);
        if (env.DB_CONNECTION_URL) {
          foundCandidate = true;
          const result = await confirmCandidate(`in ${component}.env`, env.DB_CONNECTION_URL);
          if (result === undefined) return undefined;
          if (result) return { connectionUrl: result };
        }
      }
    }
  }

  // 4. Nothing usable - ask how to proceed.
  const message = foundCandidate
    ? "None of the found connections were used. How would you like to connect?"
    : "No database connection found. Do you already have a PostgreSQL database?";

  const choice = await select({
    message,
    options: [
      { value: "existing", label: "Yes, I have a connection URL", hint: "enter your PostgreSQL connection string" },
      { value: "setup", label: "No, help me set one up", hint: "detect/install PostgreSQL and create a database" },
    ],
  });

  if (isCancel(choice)) { cancel("Cancelled."); return undefined; }

  if (choice === "setup") {
    log.step(bold("PostgreSQL setup"));
    const provision = await planPostgresProvision(host);
    return provision ? { connectionUrl: provision.url, provision } : undefined;
  }

  const url = await promptAndValidateDbUrl(host);
  return url ? { connectionUrl: url } : undefined;
}

/**
 * Prompt for a DB connection URL and test connectivity, allowing retries.
 */
async function promptAndValidateDbUrl(host: Host): Promise<string | undefined> {
  const { testPostgresConnection } = await import("./connectivity.ts");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = await text({
      message: "DB_CONNECTION_URL",
      placeholder: "postgresql://user:pass@host:5432/dbname",
      validate: (val) => {
        if (!val) return "A connection URL is required";
        if (!val.startsWith("postgres")) return "Must be a PostgreSQL connection URL";
        return undefined;
      },
    });
    if (isCancel(value)) {
      cancel("Cancelled.");
      return undefined;
    }

    const spinner = clackSpinner();
    spinner.start("Testing database connection…");
    const connResult = await testPostgresConnection(value, host);
    spinner.stop(connResult.success ? "Database connection successful" : "Database connection failed");
    if (!connResult.success && connResult.error) {
      log.error(dim(connResult.error));
    }
    if (connResult.success) {
      return value;
    }

    const action = await select({
      message: "Could not connect to the database.",
      options: [
        { value: "retry", label: "Enter a different URL" },
        { value: "proceed", label: "Use this URL anyway" },
      ],
    });
    if (isCancel(action)) {
      cancel("Cancelled.");
      return undefined;
    }
    if (action === "proceed") return value;
  }
}

export type MigrateResult = {
  success: boolean;
  errors: string[];
}

/** Where the release asset is cut from: `tar czf … -C packages/common-db/db-migration .` */
const REPO_MIGRATIONS_DIR = "packages/common-db/db-migration";

type MigrationSource = {
  folder: string;
  version: string;
}

async function resolveLocalMigrations(repoPath: string): Promise<MigrationSource | { error: string }> {
  const absRepoPath = resolve(repoPath);
  const folder = join(absRepoPath, REPO_MIGRATIONS_DIR);
  if (!existsSync(folder)) {
    const error = `No migrations found at ${folder}`;
    fail("Migrations", error);
    return { error };
  }
  pass("Migrations", `Using local migrations from ${folder}`);
  return { folder, version: await localVersionString(absRepoPath) };
}

async function resolveReleaseMigrations(targetVersion: string): Promise<MigrationSource | { error: string }> {
  const spinner = clackSpinner();
  spinner.start("Fetching release info…");
  let release: Release;
  try {
    release = await fetchRelease(targetVersion);
    spinner.stop(`Release ${cyan(release.tagName)}`);
  } catch (e) {
    spinner.stop("Failed");
    const error = e instanceof Error ? e.message : String(e);
    fail("Release", error);
    return { error };
  }

  const assetName = pickReleaseAsset(release, "db");
  const tmpDir = join(tmpdir(), `xinity-db-migrate-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const archivePath = await runSteps(downloadAndVerify(release, assetName, tmpDir));
  if (!archivePath) {
    return { error: "Download failed" };
  }

  const folder = join(tmpDir, "db-migration");
  mkdirSync(folder, { recursive: true });
  const extract = await localRun(["tar", "xzf", archivePath, "-C", folder]);
  if (!extract.ok) {
    fail("Extract", "Failed to extract migration archive");
    return { error: "Extraction failed" };
  }
  pass("Extract", "Migrations extracted");

  return { folder, version: release.tagName };
}

/** Resolve the migrations for the target version and apply them to the database. */
export async function runMigrations(opts: {
  connectionUrl: string;
  targetVersion: string;
  dryRun: boolean;
  host: Host;
  /** Store the URL/hint in the host's secrets dir and manifest (default). Stacks carry the URL themselves. */
  persist?: boolean;
}): Promise<MigrateResult> {
  const errors: string[] = [];
  const { connectionUrl } = opts;

  const source = opts.targetVersion.startsWith("local:")
    ? await resolveLocalMigrations(opts.targetVersion.slice(6))
    : await resolveReleaseMigrations(opts.targetVersion);
  if ("error" in source) {
    return { success: false, errors: [source.error] };
  }

  if (opts.dryRun) {
    info("Dry run", "Would apply migrations, skipping actual execution");
    return { success: true, errors: [] };
  }

  // Apply migrations (tunnels through SSH when targeting a remote host)
  const spinner = clackSpinner();
  const tunnel = await opts.host.openTunnel(connectionUrl);
  if (!tunnel.ok) {
    fail("Tunnel", tunnel.error);
    errors.push(tunnel.error);
    return { success: false, errors };
  }

  spinner.start("Applying migrations…");
  let connection: postgres.Sql | undefined;
  try {
    connection = postgres(tunnel.localUrl, { max: 1, onnotice: () => {} });
    const db = drizzle(connection);
    await migrate(db, { migrationsFolder: source.folder });
    spinner.stop("Migrations applied");
    pass("Migrate", "All pending migrations applied successfully");
  } catch (e) {
    spinner.stop("Failed");
    const msg = e instanceof Error ? e.message : String(e);
    fail("Migrate", msg);
    errors.push(msg);
    return { success: false, errors };
  } finally {
    if (connection) {
      await connection.end();
    }
    await tunnel.close();
  }

  if (opts.persist === false) {
    return { success: true, errors };
  }

  // Persist secret and manifest only if something actually changed.
  const hint = dbHint(connectionUrl);
  const freshManifest = await readManifest(opts.host);

  if (freshManifest.db?.hint !== hint) {
    const escaped = connectionUrl.replace(/'/g, "'\\''");
    await opts.host.withElevation(
      `mkdir -p ${SECRETS_DIR} && chmod 700 ${SECRETS_DIR}` +
      ` && printf '%s' '${escaped}' > '${DB_SECRET_PATH}' && chmod 600 '${DB_SECRET_PATH}'`,
      "Store DB connection URL secret",
    );
    await saveDbHint(hint, opts.host);
  }

  if (freshManifest.components["db"]?.version !== source.version) {
    await updateManifestEntry("db", {
      version: source.version,
      installedAt: new Date().toISOString(),
      binaryPath: "",
      unitName: "",
    }, opts.host);
  }

  return { success: true, errors };
}
