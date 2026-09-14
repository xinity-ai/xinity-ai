import journal from "../db-migration/meta/_journal.json";

/** Expected migration entries from the Drizzle journal. */
export const migrationJournal = journal;

/** Number of migrations the current schema expects to be applied. */
export const expectedMigrationCount = journal.entries.length;

/**
 * Result of a one-time migration state check at startup. `unreachable` is the
 * only variant that says nothing about the schema.
 */
export type MigrationState =
  | { status: "ok" }
  | { status: "pending"; applied: number; expected: number }
  | { status: "no_table" }
  | { status: "unreachable"; message: string }
  | { status: "error"; message: string };

/** Minimal logger surface used by {@link logMigrationFailureFatal}. */
export type MigrationFailureLogger = {
  fatal(msg: string): void;
}

/**
 * Logs a startup database failure at FATAL level, with the remedy that matches it.
 * Caller is responsible for calling `process.exit(1)` afterwards.
 */
export function logMigrationFailureFatal(
  state: MigrationState,
  log: MigrationFailureLogger,
  serviceName: string,
): void {
  if (state.status === "ok") {
    return;
  }

  if (state.status === "unreachable") {
    log.fatal(`Database is not reachable, ${serviceName} cannot start.`);
    log.fatal(state.message);
    log.fatal("Check that PostgreSQL is running and that DB_CONNECTION_URL points at it.");
    return;
  }

  log.fatal(`Database migrations are not up to date, ${serviceName} cannot start.`);
  if (state.status === "pending") {
    log.fatal(`${state.applied} of ${state.expected} migrations applied, ${state.expected - state.applied} pending.`);
  } else if (state.status === "no_table") {
    log.fatal("Migrations table not found, database not initialized.");
  } else {
    log.fatal(state.message);
  }
  log.fatal('Run "xinity up db" or "cd packages/common-db && bun run migrate" to apply migrations.');
}
