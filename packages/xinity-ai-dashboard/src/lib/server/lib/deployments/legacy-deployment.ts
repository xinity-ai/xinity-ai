import { calcCanaryProgress, deploymentCanaryT, deploymentLegacyT, deploymentT, inArray, legacyOfDeployment, modelInstallationT, sql, type Deployment, type DeploymentLegacy } from "common-db";
import type { RolloutAdvance } from "common-env";
import { MIN_CANARY_REPLICAS, type DeploymentOutput, type LegacyDeploymentInput } from "$lib/orpc/dtos/model.dto";
import { getDB } from "$lib/server/db";
import { resolvesOnlyAsLegacy } from "$lib/server/lib/models/model-catalog";
import { modelTypeMismatch } from "./canary-deployment";
import { markMissingFromCatalog, phasesOf, uninstallOwnedBy, withInstallationStatus } from "./deployment-reads";
import type { DashboardDeploymentType, Transaction } from "./deployment-types";
import { createManaged } from "./managed-deployment";
import { requirementsForDeployments } from "./requirements";

const outputOf = (entry: Deployment, legacy: DeploymentLegacy): DeploymentOutput => ({ ...entry, type: "legacy", legacy });

function withLegacyRows(entries: Deployment[]) {
  return getDB().select().from(deploymentT)
    .innerJoin(deploymentLegacyT, legacyOfDeployment)
    .where(inArray(deploymentT.id, entries.map(({ id }) => id)));
}

export async function createLegacy(tx: Transaction, input: LegacyDeploymentInput): Promise<string> {
  const [legacy] = await tx.insert(deploymentLegacyT).values(input).returning({ id: deploymentLegacyT.id });
  if (!legacy) {
    throw new Error("Insert into deploymentLegacyT returned no row");
  }
  return legacy.id;
}

// A rollout timed by both ends keeps moving as before. Feedback-driven progress never had logic behind it.
function advanceOf({ progress, canaryProgressFrom, canaryProgressUntil }: DeploymentLegacy): RolloutAdvance {
  return canaryProgressFrom && canaryProgressUntil
    ? { type: "time", version: 1, startProgress: progress, from: canaryProgressFrom.toISOString(), until: canaryProgressUntil.toISOString() }
    : { type: "manual", version: 1 };
}

/**
 * Moves the deployment onto a managed row, or a canary of two when it is mid-rollout. 
 * The installations already serving a side are handed to its new row, so nothing is installed again. 
 * The legacy row is left without a deployment, and the sync uninstalls whatever it still runs.
 */
export async function migrateLegacy(tx: Transaction, entry: Deployment): Promise<void> {
  const [legacy] = await tx.select().from(deploymentLegacyT).where(sql`${deploymentLegacyT.id} = ${entry.legacyId}`).limit(1);
  if (!legacy) {
    throw new Error(`Deployment ${entry.id} has no legacy row to migrate`);
  }
  const { replicas, preferredDriver, settings } = legacy;
  const takeOver = async (specifier: string, kvCacheSize: number | null) => {
    const managedId = await createManaged(tx, { specifier, replicas, kvCacheSize, preferredDriver, settings });
    await tx.update(modelInstallationT)
      .set({ legacyId: null, managedId })
      .where(sql`${modelInstallationT.legacyId} = ${legacy.id} AND ${modelInstallationT.specifier} = ${specifier} AND ${modelInstallationT.deletedAt} IS NULL`);
    return managedId;
  };

  const toId = await takeOver(legacy.specifier, legacy.kvCacheSize);
  const progress = Math.round(calcCanaryProgress(legacy));
  if (!legacy.earlySpecifier || legacy.earlySpecifier === legacy.specifier || progress === 100) {
    await tx.update(deploymentT).set({ type: "managed", legacyId: null, managedId: toId }).where(sql`${deploymentT.id} = ${entry.id}`);
    await uninstallOwnedBy(tx, [legacy.id]);
    return;
  }
  const fromId = await takeOver(legacy.earlySpecifier, legacy.earlyKvCacheSize);
  const [canary] = await tx.insert(deploymentCanaryT)
    .values({ fromId, toId, replicas: Math.max(MIN_CANARY_REPLICAS, replicas), progress, advance: advanceOf(legacy) })
    .returning({ id: deploymentCanaryT.id });
  if (!canary) {
    throw new Error("Insert into deploymentCanaryT returned no row");
  }
  await tx.update(deploymentT).set({ type: "canary", legacyId: null, canaryId: canary.id }).where(sql`${deploymentT.id} = ${entry.id}`);
  await uninstallOwnedBy(tx, [legacy.id]);
}

async function markDeploymentsOnDeprecatedCatalog(deployments: DeploymentOutput[]): Promise<void> {
  await Promise.all(deployments.map(async (entry) => {
    if (entry.type !== "legacy") {
      return;
    }
    const [primary, early] = await Promise.all([
      resolvesOnlyAsLegacy(entry.legacy.specifier),
      resolvesOnlyAsLegacy(entry.legacy.earlySpecifier ?? null),
    ]);
    if (primary || early) {
      entry.legacy.deprecatedModel = true;
    }
  }));
}

const RESTRICTED_WHILE_ENABLED = ["kvCacheSize", "earlyKvCacheSize", "preferredDriver", "specifier", "earlySpecifier"] as const;

async function read(entries: Deployment[]): Promise<DeploymentOutput[]> {
  const rows = await withLegacyRows(entries);
  return rows.map(({ deployment, deployment_legacy }) => outputOf(deployment, deployment_legacy));
}

const specifiersOf = (deployment: DeploymentOutput) =>
  deployment.type === "legacy" ? [deployment.legacy.specifier, deployment.legacy.earlySpecifier ?? null].filter((specifier) => specifier !== null) : [];

export const legacyDeployment: DashboardDeploymentType = {
  read,

  async withStatus(entries) {
    const deployments = await withInstallationStatus(await read(entries));
    await Promise.all([markMissingFromCatalog(deployments, specifiersOf), markDeploymentsOnDeprecatedCatalog(deployments)]);
    return deployments;
  },

  async requirements(entries) {
    const rows = await withLegacyRows(entries);
    return requirementsForDeployments(rows.map(({ deployment_legacy }) => deployment_legacy));
  },

  async phases(entries) {
    const rows = await withLegacyRows(entries);
    return phasesOf(entries, new Map(rows.map(({ deployment, deployment_legacy }) => [deployment.id, deployment_legacy.replicas])));
  },

  async reviewUpdate(entry, input) {
    const patch = input.legacy ?? {};
    if (patch.specifier) {
      const mismatch = await modelTypeMismatch(patch.specifier, patch.earlySpecifier ?? null);
      if (mismatch) {
        return { rejected: mismatch };
      }
    }

    const [row] = await withLegacyRows([entry]);
    if (!row) {
      return {};
    }
    const legacy = row.deployment_legacy;

    const staysEnabled = entry.enabled && input.enabled !== false;
    if (staysEnabled) {
      const changed = RESTRICTED_WHILE_ENABLED.filter(field => patch[field] !== undefined && patch[field] !== legacy[field]);
      if (changed.length > 0) {
        return { rejected: `Cannot change ${changed.join(", ")} while the deployment is enabled. Disable it first.` };
      }
    }

    const reenabling = input.enabled && !entry.enabled;
    const scalingUp = staysEnabled && patch.replicas !== undefined && patch.replicas > legacy.replicas;
    if (!reenabling && !scalingUp) {
      return {};
    }
    const merged = { ...legacy, ...patch };
    return { mustFit: { requirements: requirementsForDeployments([merged]), replacing: scalingUp ? [legacy.id] : undefined } };
  },

  async update(tx, entry, input) {
    const patch = input.legacy;
    if (!entry.legacyId || !patch || Object.values(patch).every((value) => value === undefined)) {
      return;
    }
    await tx.update(deploymentLegacyT).set(patch).where(sql`${deploymentLegacyT.id} = ${entry.legacyId}`);
  },
};
