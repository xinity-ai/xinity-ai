import { join } from "path";
import { sql, preconfigureDB } from "common-db";

const ROOT_DIR = join(import.meta.dir, "../..");
let ready = false;

/**
 * Ensures system test prerequisites are met:
 * 1. Loads .env if env vars aren't set
 * 2. Validates DB_CONNECTION_URL and REDIS_URL are set
 * 3. Verifies PostgreSQL is reachable
 * 4. Runs migrations (idempotent, no-op when already current)
 *
 * Call this in beforeAll() of any system test.
 * If services aren't running, fails immediately with a clear message.
 */
export async function ensureSystemReady(): Promise<void> {
  if (ready) return;

  // Load .env if vars aren't already set
  const envPath = join(ROOT_DIR, ".env");
  const envFile = Bun.file(envPath);
  if (!process.env.DB_CONNECTION_URL && (await envFile.exists())) {
    const text = await envFile.text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }

  const dbUrl = process.env.DB_CONNECTION_URL;
  if (!dbUrl) {
    throw new Error(
      "DB_CONNECTION_URL is not set.\n" +
        "  1. Copy example.env to .env (or set the var)\n" +
        "  2. Run: docker compose up -d dev",
    );
  }
  if (!process.env.REDIS_URL) {
    throw new Error(
      "REDIS_URL is not set.\n" +
        "  1. Copy example.env to .env (or set the var)\n" +
        "  2. Run: docker compose up -d dev",
    );
  }

  // Verify Postgres is reachable
  const { getDB } = preconfigureDB(dbUrl);
  try {
    await getDB().execute(sql`SELECT 1`);
  } catch {
    throw new Error(
      `PostgreSQL is not reachable at ${dbUrl}\n` +
        "  Run: docker compose up -d dev",
    );
  }

  // Run migrations (idempotent)
  const proc = Bun.spawn(["bun", "run", "migrate"], {
    cwd: join(ROOT_DIR, "packages/common-db"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Migration failed (exit ${exitCode}): ${stderr}`);
  }

  ready = true;
}
