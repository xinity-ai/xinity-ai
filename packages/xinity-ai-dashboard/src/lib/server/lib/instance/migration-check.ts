/**
 * Dashboard-specific wrapper around the shared migration check from common-db.
 * Adds logging and a SvelteKit build-phase guard.
 */
import { building } from "$app/environment";
import { rootLogger } from "$lib/server/logging";
import { checkMigrations, getDB, getMigrationState } from "$lib/server/db";
import { checkMigrations as queryMigrationState, logMigrationFailureFatal, type MigrationState } from "common-db";

const log = rootLogger.child({ name: "migration-check" });

const RECHECK_INTERVAL_MS = 5_000;
const EXIT_AFTER_MS = 60_000;

export type { MigrationState };
export { getMigrationState };

export function isMigrationOk(): boolean {
  return getMigrationState()?.status === "ok";
}

export function exitWhenMigrationsSettle(): void {
  const deadline = Date.now() + EXIT_AFTER_MS;
  const recheck = async () => {
    const state = await queryMigrationState(getDB());
    if (state.status === "ok") {
      log.info("Database migrations are up to date now, exiting so the dashboard restarts cleanly");
      process.exit(0);
    }
    if (Date.now() >= deadline) {
      logMigrationFailureFatal(state, log, "dashboard");
      process.exit(1);
    }
    setTimeout(recheck, RECHECK_INTERVAL_MS);
  };
  setTimeout(recheck, RECHECK_INTERVAL_MS);
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
