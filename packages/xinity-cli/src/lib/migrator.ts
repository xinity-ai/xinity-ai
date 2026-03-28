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
import { parseEnvString } from "./env-prompt.ts";
import { fail, pass, info } from "./output.ts";
import { postgresSetup } from "./postgres-setup.ts";
import { type Host, createLocalHost } from "./host.ts";

const ENV_DIR = "/etc/xinity-ai";

/**
 * Discover DB_CONNECTION_URL from environment or installed component configs.
 * If no existing URL is found, guides the user through an interactive setup
 * that can detect, install, and configure PostgreSQL automatically.
 */
async function discoverConnectionUrl(
  host: Host,
  dryRun: boolean,
): Promise<string | undefined> {
  // 1. Check environment variable
  if (process.env.DB_CONNECTION_URL) {
    info("DB connection", "Using DB_CONNECTION_URL from environment");
    return process.env.DB_CONNECTION_URL;
  }

  // 2. Check installed component env files on the target host
  for (const component of ["gateway", "dashboard", "daemon"]) {
    const envPath = `${ENV_DIR}/${component}.env`;
    if (await host.fileExists(envPath)) {
      const content = await host.readFile(envPath);
      if (content) {
        const env = parseEnvString(content);
        if (env.DB_CONNECTION_URL) {
          info("DB connection", `Found in ${component}.env`);
          return env.DB_CONNECTION_URL;
        }
      }
    }
  }

  // 3. No existing connection found, ask user how to proceed
  const choice = await p.select({
    message: "No existing database connection found. Do you already have a PostgreSQL database?",
    options: [
      {
        value: "existing",
        label: "Yes, I have a connection URL",
        hint: "enter your PostgreSQL connection string",
      },
      {
        value: "setup",
        label: "No, help me set one up",
        hint: "detect/install PostgreSQL and create a database",
      },
    ],
  });

  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    return undefined;
  }

  if (choice === "setup") {
    const url = await postgresSetup(host, dryRun);
    if (url) {
      const { testPostgresConnection } = await import("./connectivity.ts");
      await testPostgresConnection(url, host);
    }
    return url;
  }

  // Existing database, prompt for URL then validate connectivity
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

  return { success: true, errors, connectionUrl };
}
