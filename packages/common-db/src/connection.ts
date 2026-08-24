// https://github.com/oven-sh/bun/issues/18214

import postgres from "postgres";
// Until further notice we still need an additional pg driver, to allow LISTEN/NOTIFY to work.
// As soon as this becomes available in the bun PG driver, we should switch to that instead
// ISSUE: https://github.com/oven-sh/bun/issues/18214
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Logger } from "drizzle-orm/logger";
import { sql } from "drizzle-orm";
import { expectedMigrationCount, type MigrationState } from "./migrations";

type PinoLike = {
  debug(obj: object, msg: string): void;
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
    const msg = String(err);
    if (msg.includes("does not exist")) {
      return { status: "no_table" };
    }
    return { status: "error", message: msg };
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
