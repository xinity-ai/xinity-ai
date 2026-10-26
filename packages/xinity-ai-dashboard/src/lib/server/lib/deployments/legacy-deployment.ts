import {
  aiNodeT,
  deploymentLegacyT,
  deploymentMatchesInstallation,
  deploymentT,
  inArray,
  installationOnLiveNode,
  legacyOfDeployment,
  modelInstallationStateT,
  modelInstallationT,
  organizationT,
  sql,
  stateOfInstallation,
  type Deployment,
  type DeploymentLegacy,
} from "common-db";
import type { DeploymentInput, DeploymentOutput, DeploymentWithStatus } from "$lib/orpc/dtos/model.dto";
import { getDB } from "$lib/server/db";
import { resolveSchedulable, resolvesOnlyAsLegacy } from "$lib/server/lib/models/model-catalog";
import { foldDeploymentStatusRows } from "./deployment-status";
import type { DashboardDeploymentType, Transaction } from "./deployment-types";
import { requirementsForDeployments } from "./requirements";

// The entry's id and timestamps win over the legacy row's own.
const outputOf = (entry: Deployment, legacy: DeploymentLegacy): DeploymentOutput => ({ ...legacy, ...entry });

const idsOf = (entries: Deployment[]) => entries.map(({ id }) => id);

function withLegacyRows(entries: Deployment[]) {
  return getDB().select().from(deploymentT)
    .innerJoin(deploymentLegacyT, legacyOfDeployment)
    .where(inArray(deploymentT.id, idsOf(entries)));
}

function legacyFieldsOf(input: Partial<DeploymentInput>) {
  const { specifier, earlySpecifier, replicas, canaryProgressUntil, canaryProgressFrom, canaryProgressWithFeedback, progress, kvCacheSize, earlyKvCacheSize, preferredDriver, settings } = input;
  return { specifier, earlySpecifier, replicas, canaryProgressUntil, canaryProgressFrom, canaryProgressWithFeedback, progress, kvCacheSize, earlyKvCacheSize, preferredDriver, settings };
}

export async function createLegacy(tx: Transaction, input: Omit<DeploymentInput, "id">): Promise<string> {
  const [legacy] = await tx.insert(deploymentLegacyT).values({ ...legacyFieldsOf(input), specifier: input.specifier }).returning({ id: deploymentLegacyT.id });
  if (!legacy) {
    throw new Error("Insert into deploymentLegacyT returned no row");
  }
  return legacy.id;
}

async function resolveType(specifier: string): Promise<string | undefined> {
  const resolution = await resolveSchedulable(specifier, null);
  return resolution.status === "found" ? resolution.model.type : undefined;
}

export async function validateCanaryModelTypes(canarySpecifier: string, replacedSpecifier: string | null): Promise<string | null> {
  if (!replacedSpecifier) return null;
  const [canaryType, replacedType] = await Promise.all([
    resolveType(canarySpecifier),
    resolveType(replacedSpecifier),
  ]);
  if (canaryType && replacedType && canaryType !== replacedType) {
    return `Cannot mix model types in a canary deployment: the canary is "${canaryType}" but the model it replaces is "${replacedType}"`;
  }
  return null;
}

async function lookupIsMissingFromCatalog(specifier: string | null): Promise<boolean> {
  if (!specifier) return false;
  try {
    const resolution = await resolveSchedulable(specifier, null);
    return resolution.status === "not_found";
  } catch {
    return false;
  }
}

async function markDeploymentsMissingFromCatalog(deployments: DeploymentWithStatus[]): Promise<void> {
  const candidates = deployments.filter(d => !d.status && d.enabled);
  await Promise.all(candidates.map(async (entry) => {
    const [primaryMissing, earlyMissing] = await Promise.all([
      lookupIsMissingFromCatalog(entry.specifier ?? null),
      lookupIsMissingFromCatalog(entry.earlySpecifier ?? null),
    ]);
    if (primaryMissing || earlyMissing) {
      entry.status = { phase: "not_in_catalog", progress: null, error: null };
    }
  }));
}

async function markDeploymentsOnDeprecatedCatalog(deployments: DeploymentWithStatus[]): Promise<void> {
  await Promise.all(deployments.map(async (entry) => {
    const [primary, early] = await Promise.all([
      resolvesOnlyAsLegacy(entry.specifier ?? null),
      resolvesOnlyAsLegacy(entry.earlySpecifier ?? null),
    ]);
    if (primary || early) {
      entry.deprecatedModel = true;
    }
  }));
}

const RESTRICTED_WHILE_ENABLED = ["kvCacheSize", "earlyKvCacheSize", "preferredDriver", "specifier", "earlySpecifier"] as const;

export const legacyDeployment: DashboardDeploymentType = {
  async read(entries) {
    const rows = await withLegacyRows(entries);
    return rows.map(({ deployment, deployment_legacy }) => outputOf(deployment, deployment_legacy));
  },

  async withStatus(entries) {
    const rows = await getDB()
      .select()
      .from(deploymentT)
      .innerJoin(deploymentLegacyT, legacyOfDeployment)
      .leftJoin(modelInstallationT, sql`
        ${deploymentMatchesInstallation}
      AND
        ${modelInstallationT.deletedAt} IS NULL
      `)
      .leftJoin(modelInstallationStateT, stateOfInstallation)
      .leftJoin(aiNodeT, installationOnLiveNode)
      .where(inArray(deploymentT.id, idsOf(entries)));

    const deployments = foldDeploymentStatusRows(rows.map(({ deployment, deployment_legacy, ...installation }) => ({
      ...installation,
      deployment: outputOf(deployment, deployment_legacy),
    })));
    await Promise.all([markDeploymentsMissingFromCatalog(deployments), markDeploymentsOnDeprecatedCatalog(deployments)]);
    return deployments;
  },

  async requirements(entries) {
    const rows = await withLegacyRows(entries);
    return requirementsForDeployments(rows.map(({ deployment_legacy }) => deployment_legacy));
  },

  async phases(entries) {
    return getDB()
      .select({
        deploymentId: deploymentT.id,
        deploymentName: deploymentT.name,
        organizationId: deploymentT.organizationId,
        orgName: organizationT.name,
        publicSpecifier: deploymentT.publicSpecifier,
        desiredReplicas: deploymentLegacyT.replicas,
        installationId: modelInstallationT.id,
        installationGroup: modelInstallationT.group,
        liveNodeId: aiNodeT.id,
        lifecycleState: modelInstallationStateT.lifecycleState,
        errorMessage: modelInstallationStateT.errorMessage,
      })
      .from(deploymentT)
      .innerJoin(deploymentLegacyT, legacyOfDeployment)
      .leftJoin(organizationT, sql`${organizationT.id} = ${deploymentT.organizationId}`)
      .leftJoin(modelInstallationT, sql`
        ${deploymentMatchesInstallation}
      AND
        ${modelInstallationT.deletedAt} IS NULL
      `)
      .leftJoin(modelInstallationStateT, stateOfInstallation)
      .leftJoin(aiNodeT, installationOnLiveNode)
      .where(inArray(deploymentT.id, idsOf(entries)));
  },

  async reviewUpdate(entry, input) {
    if (input.specifier) {
      const mismatch = await validateCanaryModelTypes(input.specifier, input.earlySpecifier ?? null);
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
      const changed = RESTRICTED_WHILE_ENABLED.filter(field => input[field] !== undefined && input[field] !== legacy[field]);
      if (changed.length > 0) {
        return { rejected: `Cannot change ${changed.join(", ")} while the deployment is enabled. Disable it first.` };
      }
    }

    const reenabling = input.enabled && !entry.enabled;
    const scalingUp = staysEnabled && input.replicas !== undefined && input.replicas > legacy.replicas;
    if (!reenabling && !scalingUp) {
      return {};
    }
    const merged = { ...legacy, ...input, id: legacy.id };
    return { mustFit: { requirements: requirementsForDeployments([merged]), replacing: scalingUp ? legacy.id : undefined } };
  },

  async update(tx, entry, input) {
    const fields = legacyFieldsOf(input);
    if (!entry.legacyId || Object.values(fields).every((value) => value === undefined)) {
      return;
    }
    await tx.update(deploymentLegacyT).set(fields).where(sql`${deploymentLegacyT.id} = ${entry.legacyId}`);
  },
};
