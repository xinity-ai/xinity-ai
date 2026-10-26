import { sql } from "common-db";
import { createDependencyProbe, createHealthHandler, parseMetricsAuth } from "common-env";
import { config } from "$lib/server/config";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { isMigrationOk } from "./migration-check";

const PROBE_INTERVAL_MS = 10_000;

const databaseProbe = createDependencyProbe({
  name: "Database",
  ping: () => getDB().execute(sql`SELECT 1`),
  log: rootLogger.child({ name: "health" }),
});

export function startHealthProbe(): () => void {
  databaseProbe.start(PROBE_INTERVAL_MS);
  return databaseProbe.stop;
}

export const handleHealth = createHealthHandler({
  readiness: {
    database: databaseProbe.check,
    migrations: () => (isMigrationOk() ? null : "outdated"),
  },
  credentials: parseMetricsAuth(config.metrics.auth),
});
