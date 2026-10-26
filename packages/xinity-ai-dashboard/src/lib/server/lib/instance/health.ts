import { createDatabaseProbe, databaseDeprecationChecks, isNull, modelDeploymentT } from "common-db";
import { createHealthHandler, parseMetricsAuth } from "common-env";
import { config } from "$lib/server/config";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { resolvesOnlyAsLegacy } from "$lib/server/lib/models/model-catalog";
import { isMigrationOk } from "./migration-check";

const databaseProbe = createDatabaseProbe(getDB, rootLogger.child({ name: "health" }));

export function startHealthProbe(): () => void {
  databaseProbe.start();
  return databaseProbe.stop;
}

async function deploymentsOnLegacyCatalog(): Promise<string | null> {
  const deployments = await getDB()
    .select({ name: modelDeploymentT.publicSpecifier, specifier: modelDeploymentT.specifier, earlySpecifier: modelDeploymentT.earlySpecifier })
    .from(modelDeploymentT)
    .where(isNull(modelDeploymentT.deletedAt));
  const affected = await Promise.all(deployments.map(async (d) =>
    (await resolvesOnlyAsLegacy(d.specifier)) || (await resolvesOnlyAsLegacy(d.earlySpecifier)) ? d.name : null));
  const names = affected.filter((name) => name !== null);
  return names.length > 0
    ? `${names.length} deployments resolve their model only through the v1 catalog (${names.join(", ")}). Move each to a model in the current catalog.`
    : null;
}

export const handleHealth = createHealthHandler({
  readiness: {
    database: databaseProbe.check,
    migrations: () => (isMigrationOk() ? null : "outdated"),
  },
  deprecations: {
    ...databaseDeprecationChecks(getDB),
    "deployments.legacy-catalog": deploymentsOnLegacyCatalog,
  },
  credentials: parseMetricsAuth(config.metrics.auth),
});
