import { count } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DeprecationChecks } from "common-env";
import { apiCallT } from "./schema/call-data";

/** Shared database state outlives every service's code, so each service with a connection reports it. */
export function databaseDeprecationChecks(getDB: () => PostgresJsDatabase): DeprecationChecks {
  return {
    "dashboard.legacy-api-calls": async () => {
      const [row] = await getDB().select({ calls: count() }).from(apiCallT);
      const calls = row?.calls ?? 0;
      return calls > 0
        ? `${calls} API calls are still in the legacy table. Convert them under Instance Settings > Maintenance.`
        : null;
    },
  };
}
