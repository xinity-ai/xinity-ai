// https://github.com/oven-sh/bun/issues/18214

import postgres from "postgres";
// Until further notice we still need an additional pg driver, to allow LISTEN/NOTIFY to work.
// As soon as this becomes available in the bun PG driver, we should switch to that instead
// ISSUE: https://github.com/oven-sh/bun/issues/18214
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { type Logger } from "drizzle-orm/logger";
import { sql } from "drizzle-orm";
import { expectedMigrationCount, type MigrationState } from "./migrations";

interface PinoLike {
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
    const applied = Array.from(rows)[0]?.count ?? 0;

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
export function preconfigureDB(DB_CONNECTION_URL: string, pinoLogger?: PinoLike) {
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

  function ensureConnection() {
    if (db) return db;
    connection ??= postgres(DB_CONNECTION_URL);
    return (db ??= drizzleLogger ? drizzle(connection, { logger: drizzleLogger }) : drizzle(connection));
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

    async* listen(channel: string) {
      connection ??= postgres(DB_CONNECTION_URL);
      yield* fromCallback(callback => connection.listen(channel, callback), async x => {
        const o = await x;
        process.on("beforeExit", () => o.unlisten());
      })
    },
  }
}

/**
 * Bridges a callback-based subscription into an async generator.
 */
async function* fromCallback<T, K>(register: (callback: (val: T) => void) => K, postRegister: (k: K) => void = () => { }) {
  type Phe = { value: T, done: boolean };
  const queue: T[] = [];
  let resolveNext: ((_: Phe) => void) | undefined;
  let done = false;

  postRegister(register(value => {
    if (resolveNext) {
      resolveNext({ value, done: false });
      resolveNext = undefined;
    } else {
      queue.push(value);
    }
  }));

  try {
    while (!done) {
      if (queue.length) {
        yield queue.shift();
      } else {
        const result = await new Promise<Phe>(resolve => (resolveNext = resolve));
        if (result.done) break;
        yield result.value;
      }
    }
  } finally {
    done = true;
  }
}
