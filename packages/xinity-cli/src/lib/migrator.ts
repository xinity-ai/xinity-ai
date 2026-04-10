/**
 * Database migration runner for `xinity up db`.
 *
 * Downloads the migration tarball from a GitHub release, extracts it,
 * discovers or prompts for DB_CONNECTION_URL, then applies pending
 * migrations using drizzle-orm's programmatic migrator.
 */
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as p from "./clack.ts";
import pc from "picocolors";

import { fetchRelease, getAssetName, type Release } from "./github.ts";
import { downloadAndVerify } from "./installer.ts";
import { parseEnvString } from "./env-file.ts";
import { fail, pass, info, warn } from "./output.ts";
import { postgresSetup } from "./postgres-setup.ts";
import { type Host, createLocalHost } from "./host.ts";
import { readManifest, saveDbHint, updateManifestEntry } from "./manifest.ts";

const ENV_DIR = "/etc/xinity-ai";
const DB_SECRET_PATH = "/etc/xinity-ai/secrets/DB_CONNECTION_URL";

/**
 * Return a safe display string for a postgres URL: user@host:port/dbname.
 * Never includes the password.
 */
function dbHint(url: string): string {
  try {
    const u = new URL(url);
    const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    const db = u.pathname.replace(/^\//, "") || "(default)";
    return u.username ? `${u.username}@${host}/${db}` : `${host}/${db}`;
  } catch {
    return "(invalid URL)";
  }
}

/**
 * Offer a discovered candidate URL to the user, showing only the safe hint.
 * Returns the full URL if accepted, null if declined, undefined if cancelled.
 */
async function confirmCandidate(
  label: string,
  url: string,
): Promise<string | null | undefined> {
  const use = await p.confirm({
    message: `DB connection found ${label} (${dbHint(url)}). Use this?`,
    initialValue: true,
  });
  if (p.isCancel(use)) { p.cancel("Cancelled."); return undefined; }
  return use ? url : null;
}

/**
 * Discover DB_CONNECTION_URL from environment, stored secret, or installed
 * component configs. Confirms each candidate before returning it. If nothing
 * usable is found, guides the user through interactive setup.
 */
async function discoverConnectionUrl(
  host: Host,
  dryRun: boolean,
): Promise<string | undefined> {
  let foundCandidate = false;

  // 1. Previously stored secret on the target host (written by a prior migration run).
  //    The manifest carries only a safe hint (user@host/db, no password). Confirm
  //    based on that - only elevate to read the actual secret after the user says yes.
  const manifest = await readManifest(host);
  if (manifest.db?.hint) {
    foundCandidate = true;
    const use = await p.confirm({
      message: `DB connection found in stored secret (${manifest.db.hint}). Use this?`,
      initialValue: true,
    });
    if (p.isCancel(use)) { p.cancel("Cancelled."); return undefined; }
    if (use) {
      // Append `; echo` so the output ends with a newline, keeping the ::exit:: marker
      // on its own line regardless of whether the secret file has a trailing newline.
      const readResult = await host.withElevation(
        `cat '${DB_SECRET_PATH}'; echo`,
        "Read stored DB connection URL",
        { sensitive: true },
      );
      if (readResult.success && readResult.output.trim()) return readResult.output.trim();
      warn("DB secret", "Could not read stored secret - please provide the URL manually");
      // Fall through to manual entry
    }
  }

  // 2. Environment variable - may point to a local dev DB unrelated to the host.
  if (process.env.DB_CONNECTION_URL) {
    foundCandidate = true;
    const result = await confirmCandidate("in environment", process.env.DB_CONNECTION_URL);
    if (result === undefined) return undefined;
    if (result) return result;
  }

  // 3. Component env files on the target host.
  for (const component of ["gateway", "dashboard", "daemon"]) {
    const envPath = `${ENV_DIR}/${component}.env`;
    if (await host.fileExists(envPath)) {
      const content = await host.readFile(envPath);
      if (content) {
        const env = parseEnvString(content);
        if (env.DB_CONNECTION_URL) {
          foundCandidate = true;
          const result = await confirmCandidate(`in ${component}.env`, env.DB_CONNECTION_URL);
          if (result === undefined) return undefined;
          if (result) return result;
        }
      }
    }
  }

  // 4. Nothing usable - ask how to proceed.
  const message = foundCandidate
    ? "None of the found connections were used. How would you like to connect?"
    : "No database connection found. Do you already have a PostgreSQL database?";

  const choice = await p.select({
    message,
    options: [
      { value: "existing", label: "Yes, I have a connection URL", hint: "enter your PostgreSQL connection string" },
      { value: "setup", label: "No, help me set one up", hint: "detect/install PostgreSQL and create a database" },
    ],
  });

  if (p.isCancel(choice)) { p.cancel("Cancelled."); return undefined; }

  if (choice === "setup") {
    const url = await postgresSetup(host, dryRun);
    if (url) {
      const { testPostgresConnection } = await import("./connectivity.ts");
      await testPostgresConnection(url, host);
    }
    return url;
  }

  return promptAndValidateDbUrl(host);
}

/**
 * Prompt for a DB connection URL and test connectivity, allowing retries.
 */
async function promptAndValidateDbUrl(host: Host): Promise<string | undefined> {
  const { testPostgresConnection } = await import("./connectivity.ts");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = await p.text({
      message: "DB_CONNECTION_URL",
      placeholder: "postgresql://user:pass@host:5432/dbname",
      validate: (val) => {
        if (!val) return "A connection URL is required";
        if (!val.startsWith("postgres")) return "Must be a PostgreSQL connection URL";
        return undefined;
      },
    });
    if (p.isCancel(value)) {
      p.cancel("Cancelled.");
      return undefined;
    }

    const ok = await testPostgresConnection(value, host);
    if (ok) return value;

    const action = await p.select({
      message: "Could not connect to the database.",
      options: [
        { value: "retry", label: "Enter a different URL" },
        { value: "proceed", label: "Use this URL anyway" },
      ],
    });
    if (p.isCancel(action) || action === "proceed") return value;
  }
}

export interface MigrateResult {
  success: boolean;
  errors: string[];
  /** The DB connection URL that was used (or discovered), if any. */
  connectionUrl?: string;
}

/**
 * Download migrations from a release, extract, and apply to the database.
 */
export async function runMigrations(opts: {
  targetVersion: string;
  dryRun: boolean;
  host: Host;
}): Promise<MigrateResult> {
  const errors: string[] = [];

  // 1. Discover DB connection URL first, before any spinners run.
  //    This keeps the interactive select prompt clean (spinners can
  //    interfere with terminal raw-mode), and avoids downloading
  //    migrations if the user cancels or needs to install Postgres first.
  const connectionUrl = await discoverConnectionUrl(opts.host, opts.dryRun);
  if (!connectionUrl) {
    return { success: false, errors: ["No DB connection URL provided"] };
  }

  // 2. Fetch release
  const spinner = p.spinner();
  spinner.start("Fetching release info…");
  let release: Release;
  try {
    release = await fetchRelease(opts.targetVersion);
    spinner.stop(`Release ${pc.cyan(release.tagName)}`);
  } catch (e) {
    spinner.stop("Failed");
    const msg = e instanceof Error ? e.message : String(e);
    fail("Release", msg);
    return { success: false, errors: [msg], connectionUrl };
  }

  // 3. Download & verify
  const assetName = getAssetName("db");
  const tmpDir = join(tmpdir(), `xinity-db-migrate-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const archivePath = await downloadAndVerify(release, assetName, tmpDir);
  if (!archivePath) {
    return { success: false, errors: [], connectionUrl };
  }

  // 4. Extract
  const extractDir = join(tmpDir, "db-migration");
  mkdirSync(extractDir, { recursive: true });
  const local = createLocalHost();
  const extract = await local.run(["tar", "xzf", archivePath, "-C", extractDir]);
  if (!extract.ok) {
    fail("Extract", "Failed to extract migration archive");
    return { success: false, errors: ["Extraction failed"], connectionUrl };
  }
  pass("Extract", "Migrations extracted");

  if (opts.dryRun) {
    info("Dry run", "Would apply migrations, skipping actual execution");
    return { success: true, errors: [], connectionUrl };
  }

  // 5. Apply migrations (tunnels through SSH when targeting a remote host)
  const tunnel = await opts.host.openTunnel(connectionUrl);

  spinner.start("Applying migrations…");
  let connection: postgres.Sql | undefined;
  try {
    connection = postgres(tunnel.localUrl, { max: 1, onnotice: () => {} });
    const db = drizzle(connection);
    await migrate(db, { migrationsFolder: extractDir });
    spinner.stop("Migrations applied");
    pass("Migrate", "All pending migrations applied successfully");
  } catch (e) {
    spinner.stop("Failed");
    const msg = e instanceof Error ? e.message : String(e);
    fail("Migrate", msg);
    errors.push(msg);
    return { success: false, errors, connectionUrl };
  } finally {
    if (connection) {
      await connection.end();
    }
    await tunnel.close();
  }

  // Persist secret and manifest only if something actually changed.
  const hint = dbHint(connectionUrl);
  const freshManifest = await readManifest(opts.host);

  if (freshManifest.db?.hint !== hint) {
    const escaped = connectionUrl.replace(/'/g, "'\\''");
    await opts.host.withElevation(
      `mkdir -p /etc/xinity-ai/secrets && chmod 700 /etc/xinity-ai/secrets` +
      ` && printf '%s' '${escaped}' > '${DB_SECRET_PATH}' && chmod 600 '${DB_SECRET_PATH}'`,
      "Store DB connection URL secret",
    );
    await saveDbHint(hint, opts.host);
  }

  if (freshManifest.components["db"]?.version !== release.tagName) {
    await updateManifestEntry("db", {
      version: release.tagName,
      installedAt: new Date().toISOString(),
      binaryPath: "",
      unitName: "",
    }, opts.host);
  }

  return { success: true, errors, connectionUrl };
}
