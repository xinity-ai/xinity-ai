import journal from "../db-migration/meta/_journal.json";

/** Expected migration entries from the Drizzle journal. */
export const migrationJournal = journal;

/** Number of migrations the current schema expects to be applied. */
export const expectedMigrationCount = journal.entries.length;

/** Result of a one-time migration state check at startup. */
export type MigrationState =
  | { status: "ok" }
  | { status: "pending"; applied: number; expected: number }
  | { status: "no_table" }
  | { status: "error"; message: string };
