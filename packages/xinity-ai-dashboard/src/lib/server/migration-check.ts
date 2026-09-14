/**
 * Dashboard-specific wrapper around the shared migration check from common-db.
 * Adds logging and a SvelteKit build-phase guard.
 */
import { building } from "$app/environment";
import { rootLogger } from "$lib/server/logging";
import { checkMigrations, getMigrationState } from "$lib/server/db";
import type { MigrationState } from "common-db";

const log = rootLogger.child({ name: "migration-check" });

export type { MigrationState };
export { getMigrationState };

export function isMigrationOk(): boolean {
  return getMigrationState()?.status === "ok";
}

export async function checkMigrationState(): Promise<MigrationState> {
  if (building) {
    return { status: "ok" };
  }

  const state = await checkMigrations();

  switch (state.status) {
    case "ok":
      log.info("All database migrations applied");
      break;
    case "pending":
      log.error(
        { applied: state.applied, expected: state.expected },
        "Database migrations are outdated, dashboard will be blocked",
      );
      break;
    case "no_table":
      log.error("Drizzle migrations table not found, database not initialized");
      break;
    case "error":
      log.error({ message: state.message }, "Failed to check migration state");
      break;
  }

  return state;
}
