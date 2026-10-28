import { deploymentLegacyT, deploymentT, inArray, legacyOfDeployment, sql, type Deployment, type DeploymentLegacy } from "common-db";
import type { DeploymentOutput, LegacyDeploymentInput } from "$lib/orpc/dtos/model.dto";
import { getDB } from "$lib/server/db";
import { resolvesOnlyAsLegacy } from "$lib/server/lib/models/model-catalog";
import { validateCanaryModelTypes } from "./canary-deployment";
import { markMissingFromCatalog, phasesOf, withInstallationStatus } from "./deployment-reads";
import type { DashboardDeploymentType, Transaction } from "./deployment-types";
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
      const mismatch = await validateCanaryModelTypes(patch.specifier, patch.earlySpecifier ?? null);
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
