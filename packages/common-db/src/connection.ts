// postgres.js rather than Bun.SQL, whose pool opens `max` connections on the
// first query instead of growing with load, so every service would claim its
// ceiling at startup. Switch once https://github.com/oven-sh/bun/pull/30636 lands.
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Logger } from "drizzle-orm/logger";
import { sql } from "drizzle-orm";
import type { PinoLike } from "common-env";
import { expectedMigrationCount, type MigrationState } from "./migrations";

const UNREACHABLE_CODES = new Set([
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

const NO_TABLE_CODES = new Set([
  "42P01", // undefined_table
  "3F000", // invalid_schema_name
]);

/** Drizzle wraps driver errors, so the SQLSTATE is on `cause`, not on the error we catch. */
function driverErrorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const { code } = current as Error & { code?: unknown };
    if (typeof code === "string") {
      return code;
    }
    current = current.cause;
  }
  return null;
}

/**
 * Queries the Drizzle migrations table and compares the applied count
 * against the expected count from the compiled migration journal.
 */
export async function checkMigrations(db: PostgresJsDatabase): Promise<MigrationState> {
  try {
    const rows = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM "drizzle"."__drizzle_migrations"`,
    );
    const applied = rows[0]?.count ?? 0;

    if (applied >= expectedMigrationCount) {
      return { status: "ok" };
    }
    return { status: "pending", applied, expected: expectedMigrationCount };
  } catch (err) {
    const message = String(err);
    const code = driverErrorCode(err);
    if (code && UNREACHABLE_CODES.has(code)) {
      return { status: "unreachable", message };
    }
    if (code && NO_TABLE_CODES.has(code)) {
      return { status: "no_table" };
    }
    return { status: "error", message };
  }
}

/**
 * Pre-configures a lazy database connection without actually connecting.
 *
 * Callers should `await checkMigrations()` before using `getDB()`.
 */
export function preconfigureDB(
  DB_CONNECTION_URL: string,
  pinoLogger?: PinoLike,
  options?: postgres.Options<Record<string, never>>,
) {
  let connection: postgres.Sql;
  let db: PostgresJsDatabase;
  let migrationState: MigrationState | null = null;

  const drizzleLogger: Logger | undefined = pinoLogger
    ? {
        logQuery(query: string, params: unknown[]) {
          pinoLogger.debug({ query, params }, "query");
        },
      }
    : undefined;

  function ensurePostgresConnection(): postgres.Sql {
    const defaultMax = 10;

    const mergedOptions: postgres.Options<Record<string, never>> = {
      max: defaultMax,
      idle_timeout: 30,
      connect_timeout: 10,
      prepare: true,
    };

    if (options) {
      for (const [key, val] of Object.entries(options)) {
        if (val !== undefined) {
          (mergedOptions as any)[key] = val;
        }
      }
    }

    return connection ??= postgres(DB_CONNECTION_URL, mergedOptions);
  }

  function ensureConnection(): PostgresJsDatabase {
    if (!db) {
      const sql = ensurePostgresConnection();
      db = drizzleLogger ? drizzle(sql, { logger: drizzleLogger }) : drizzle(sql);
    }
    return db;
  }

  return {
    async checkMigrations(): Promise<MigrationState> {
      return (migrationState ??= await checkMigrations(ensureConnection()));
    },

    getDB() {
      return ensureConnection();
    },

    getMigrationState(): MigrationState | null {
      return migrationState;
    },

    /**
     * All channels share one dedicated connection, so subscribing per channel is cheap.
     * `onSubscribed` fires again whenever a dropped connection is re-established, which is
     * the only chance a caller gets to re-sync state that changed while it was deaf.
     */
    async subscribe(
      channel: string,
      onNotify: (payload: string) => void,
      onSubscribed?: () => void,
    ): Promise<() => Promise<void>> {
      const subscription = await ensurePostgresConnection().listen(channel, onNotify, onSubscribed);
      return () => subscription.unlisten();
    },

    async end(): Promise<void> {
      if (connection) {
        await connection.end();
      }
    },
  }
}
