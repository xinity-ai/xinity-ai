import { calcCanaryProgress, sql, inArray, deploymentLegacyT, type Deployment, type DeploymentLegacy } from "common-db";
import { getDB } from "../db";
import type { GatewayDeploymentType, ModelDescription } from "./deployment-types";
import type { ModelLookup } from "./model-data";
import { deriveStatus, getModelSources, placedInstallations, replicaLifecycles, resolveMaxContextLengths, selectAdmittedHost, shortestContext } from "./installations";

export type LegacyPayload = {
  id: string;
  specifier: string;
  earlySpecifier: string | null;
  progress: number;
  canaryProgressFrom: number | null;
  canaryProgressUntil: number | null;
};

function canaryProgressOf(payload: LegacyPayload): number {
  return calcCanaryProgress({
    ...payload,
    canaryProgressFrom: payload.canaryProgressFrom !== null ? new Date(payload.canaryProgressFrom) : null,
    canaryProgressUntil: payload.canaryProgressUntil !== null ? new Date(payload.canaryProgressUntil) : null,
  });
}

async function loadLegacy(entry: Deployment): Promise<LegacyPayload | undefined> {
  const [row] = await getDB().select().from(deploymentLegacyT)
    .where(sql`${deploymentLegacyT.id} = ${entry.legacyId}`)
    .limit(1);
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    specifier: row.specifier,
    earlySpecifier: row.earlySpecifier,
    progress: row.progress,
    canaryProgressFrom: row.canaryProgressFrom?.valueOf() ?? null,
    canaryProgressUntil: row.canaryProgressUntil?.valueOf() ?? null,
  };
}

async function resolveLegacy(payload: LegacyPayload, publicSpecifier: string, prefixHashes?: string[]): Promise<ModelLookup> {
  const owner = { column: "legacyId", id: payload.id } as const;
  const early = payload.earlySpecifier;
  const [finalSources, earlySources] = await Promise.all([
    getModelSources(owner, payload.specifier),
    early ? getModelSources(owner, early) : undefined,
  ]);
  return selectAdmittedHost({
    final: { specifier: payload.specifier, sources: finalSources },
    early: early && earlySources ? { specifier: early, sources: earlySources } : undefined,
    progress: canaryProgressOf(payload),
    publicSpecifier,
    prefixHashes,
  });
}

async function describeLegacy(entries: Deployment[]): Promise<Map<string, ModelDescription>> {
  const legacyIds = entries.flatMap((entry) => entry.legacyId ?? []);
  if (legacyIds.length === 0) {
    return new Map();
  }
  const [legacies, placed] = await Promise.all([
    getDB().select().from(deploymentLegacyT).where(inArray(deploymentLegacyT.id, legacyIds)),
    placedInstallations("legacyId", legacyIds),
  ]);
  const servingSpecifiers = (legacy: DeploymentLegacy) =>
    legacy.earlySpecifier && calcCanaryProgress(legacy) !== 100
      ? [legacy.specifier, legacy.earlySpecifier]
      : [legacy.specifier];
  const contextLengths = await resolveMaxContextLengths([...new Set(legacies.flatMap(servingSpecifiers))]);
  const legacyById = new Map(legacies.map((legacy) => [legacy.id, legacy]));

  return new Map(entries.flatMap((entry) => {
    const legacy = entry.legacyId ? legacyById.get(entry.legacyId) : undefined;
    if (!legacy) {
      return [];
    }
    const description: ModelDescription = {
      status: deriveStatus(replicaLifecycles(placed.get(legacy.id) ?? [])),
      canary: calcCanaryProgress(legacy) !== 100,
      maxModelLen: shortestContext(servingSpecifiers(legacy), contextLengths),
    };
    return [[entry.id, description] as const];
  }));
}

export const legacyDeployment: GatewayDeploymentType<LegacyPayload> = {
  load: loadLegacy,
  resolve: resolveLegacy,
  describe: describeLegacy,
};
