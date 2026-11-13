import {
  aiNodeT,
  canaryOfDeployment,
  deploymentCanaryT,
  deploymentT,
  inArray,
  installationOfDeployment,
  installationOnLiveNode,
  modelInstallationStateT,
  modelInstallationT,
  sql,
  stateOfInstallation,
  type Deployment,
} from "common-db";
import { CANARY_MEMBERS, type DeploymentOutput } from "$lib/orpc/dtos/model.dto";
import { getDB } from "$lib/server/db";
import { resolveSchedulable } from "$lib/server/lib/models/model-catalog";
import { foldDeploymentStatusRows, wantedOf } from "./deployment-status";
import type { Transaction } from "./deployment-types";

const idsOf = (entries: { id: string }[]) => entries.map(({ id }) => id);

const liveInstallation = sql`${installationOfDeployment} AND ${modelInstallationT.deletedAt} IS NULL`;

export async function withInstallationStatus(deployments: DeploymentOutput[]): Promise<DeploymentOutput[]> {
  const byId = new Map(deployments.map((deployment) => [deployment.id, deployment]));
  const rows = await getDB()
    .select({
      deploymentId: deploymentT.id,
      fromId: deploymentCanaryT.fromId,
      toId: deploymentCanaryT.toId,
      model_installation: modelInstallationT,
      model_installation_state: modelInstallationStateT,
      ai_node: aiNodeT,
    })
    .from(deploymentT)
    .leftJoin(deploymentCanaryT, canaryOfDeployment)
    .leftJoin(modelInstallationT, liveInstallation)
    .leftJoin(modelInstallationStateT, stateOfInstallation)
    .leftJoin(aiNodeT, installationOnLiveNode)
    .where(inArray(deploymentT.id, idsOf(deployments)));
  return foldDeploymentStatusRows(rows.flatMap(({ deploymentId, fromId, toId, ...installation }) => {
    const deployment = byId.get(deploymentId);
    const ownerId = installation.model_installation?.managedId;
    const side = CANARY_MEMBERS.find((member) => ownerId && ownerId === { from: fromId, to: toId }[member]);
    return deployment ? [{ ...installation, deployment, side }] : [];
  }));
}

async function isMissingFromCatalog(specifier: string): Promise<boolean> {
  try {
    const resolution = await resolveSchedulable(specifier, null);
    return resolution.status === "not_found";
  } catch {
    return false;
  }
}

// An enabled deployment with no installation to report on may simply have a model the catalog no longer has.
export async function markMissingFromCatalog(deployments: DeploymentOutput[], specifiersOf: (deployment: DeploymentOutput) => string[]): Promise<void> {
  const candidates = deployments.filter((deployment) => !deployment.status && deployment.enabled);
  await Promise.all(candidates.map(async (deployment) => {
    const missing = await Promise.all(specifiersOf(deployment).map(isMissingFromCatalog));
    if (missing.some(Boolean)) {
      deployment.status = { phase: "not_in_catalog", progress: null, error: null, wanted: wantedOf(deployment) };
    }
  }));
}

/** Ids of the rows whose installations serve the deployment. */
export async function installationOwnersOf(entry: Deployment, db: Transaction | ReturnType<typeof getDB> = getDB()): Promise<string[]> {
  const [canary] = entry.canaryId
    ? await db.select().from(deploymentCanaryT).where(sql`${deploymentCanaryT.id} = ${entry.canaryId}`).limit(1)
    : [];
  return [entry.legacyId, entry.managedId, canary?.fromId, canary?.toId].filter((id) => typeof id === "string");
}

export async function uninstallOwnedBy(tx: Transaction, ownerIds: string[]): Promise<void> {
  await tx.update(modelInstallationT).set({ deletedAt: new Date() }).where(sql`
    (${inArray(modelInstallationT.legacyId, ownerIds)} OR ${inArray(modelInstallationT.managedId, ownerIds)})
    AND ${modelInstallationT.deletedAt} IS NULL
  `);
}
