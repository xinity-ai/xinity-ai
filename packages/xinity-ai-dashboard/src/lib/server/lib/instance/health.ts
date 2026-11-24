import { canaryOfDeployment, createDatabaseProbe, databaseDeprecationChecks, deploymentCanaryT, deploymentLegacyT, deploymentManagedT, deploymentT, isNull, legacyOfDeployment, sql } from "common-db";
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
    .select({ name: deploymentT.publicSpecifier, legacy: deploymentLegacyT.specifier, legacyEarly: deploymentLegacyT.earlySpecifier, managed: deploymentManagedT.specifier })
    .from(deploymentT)
    .leftJoin(deploymentLegacyT, legacyOfDeployment)
    .leftJoin(deploymentCanaryT, canaryOfDeployment)
    .leftJoin(deploymentManagedT, sql`${deploymentManagedT.id} IN (${deploymentT.managedId}, ${deploymentCanaryT.fromId}, ${deploymentCanaryT.toId})`)
    .where(isNull(deploymentT.deletedAt));
  const affected = await Promise.all(deployments.map(async (d) =>
    (await resolvesOnlyAsLegacy(d.legacy)) || (await resolvesOnlyAsLegacy(d.legacyEarly)) || (await resolvesOnlyAsLegacy(d.managed)) ? d.name : null));
  const names = [...new Set(affected.filter((name) => name !== null))];
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
