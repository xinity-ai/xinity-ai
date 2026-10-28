import { calcRolloutProgress, canaryOfDeployment, deploymentCanaryT, deploymentManagedT, deploymentT, inArray, sql, type Deployment, type DeploymentCanary, type DeploymentManaged } from "common-db";
import type { RolloutAdvance } from "common-env";
import type { DeploymentOutput, RolloutAdvanceInput } from "$lib/orpc/dtos/model.dto";
import { getDB } from "$lib/server/db";
import { resolveSchedulable } from "$lib/server/lib/models/model-catalog";
import { markMissingFromCatalog, phasesOf, withInstallationStatus } from "./deployment-reads";
import type { DashboardDeploymentType } from "./deployment-types";
import { hasChanges, rejectWhileEnabled, restrictedChanges } from "./managed-deployment";
import { requirementsForCanaries, type CanaryPlan } from "./requirements";
import { handleVariant, type VariantHandlers } from "$lib/util";

type CanaryRow = { entry: Deployment; canary: DeploymentCanary; from: DeploymentManaged; to: DeploymentManaged };

async function withCanaryRows(entries: Deployment[]): Promise<CanaryRow[]> {
  const rows = await getDB().select().from(deploymentT)
    .innerJoin(deploymentCanaryT, canaryOfDeployment)
    .where(inArray(deploymentT.id, entries.map(({ id }) => id)));
  if (rows.length === 0) {
    return [];
  }
  const members = await getDB().select().from(deploymentManagedT)
    .where(inArray(deploymentManagedT.id, rows.flatMap(({ deployment_canary }) => [deployment_canary.fromId, deployment_canary.toId])));
  const memberById = new Map(members.map((member) => [member.id, member]));
  return rows.flatMap(({ deployment, deployment_canary: canary }) => {
    const from = memberById.get(canary.fromId);
    const to = memberById.get(canary.toId);
    return from && to ? [{ entry: deployment, canary, from, to }] : [];
  });
}

const outputOf = ({ entry, canary, from, to }: CanaryRow): DeploymentOutput => ({ ...entry, type: "canary", canary: { ...canary, from, to } });

async function read(entries: Deployment[]): Promise<DeploymentOutput[]> {
  return (await withCanaryRows(entries)).map(outputOf);
}

async function resolveType(specifier: string): Promise<string | undefined> {
  const resolution = await resolveSchedulable(specifier, null);
  return resolution.status === "found" ? resolution.model.type : undefined;
}

export async function validateCanaryModelTypes(toSpecifier: string, fromSpecifier: string | null): Promise<string | null> {
  if (!fromSpecifier) {
    return null;
  }
  const [toType, fromType] = await Promise.all([resolveType(toSpecifier), resolveType(fromSpecifier)]);
  if (toType && fromType && toType !== fromType) {
    return `Cannot mix model types in a canary deployment: the canary is "${toType}" but the model it replaces is "${fromType}"`;
  }
  return null;
}

// A time-based advance moves on evenly from the progress and time it is given.
const STORED_ADVANCE: VariantHandlers<RolloutAdvanceInput, RolloutAdvance, [number]> = {
  manual: () => ({ type: "manual", version: 1 }),
  time: ({ until }, progress) => ({ type: "time", version: 1, startProgress: progress, from: new Date().toISOString(), until: until.toISOString() }),
};

// Setting progress by hand under a time-based advance restarts it from there, towards the same end.
const REANCHORED_ADVANCE: VariantHandlers<RolloutAdvance, RolloutAdvance, [number]> = {
  manual: (advance) => advance,
  time: (advance, progress) => ({ ...advance, startProgress: progress, from: new Date().toISOString() }),
};

function advanceChange(current: DeploymentCanary, progress: number | undefined, advance: RolloutAdvanceInput | undefined): RolloutAdvance | undefined {
  if (advance) {
    return handleVariant(STORED_ADVANCE, advance, progress ?? current.progress);
  }
  return progress === undefined ? undefined : handleVariant(REANCHORED_ADVANCE, current.advance, progress);
}

const PROGRESS_NOW: VariantHandlers<RolloutAdvance, number | undefined> = {
  manual: () => undefined,
  time: ({ startProgress, from, until }) =>
    calcRolloutProgress({ progress: startProgress, canaryProgressFrom: new Date(from), canaryProgressUntil: new Date(until) }),
};

/** Writes the progress each canary's advance has reached by now, which is what the gateway splits traffic by. */
export async function advanceRollouts(): Promise<void> {
  const canaries = await getDB().select().from(deploymentCanaryT);
  await Promise.all(canaries.map(async (canary) => {
    const progress = handleVariant(PROGRESS_NOW, canary.advance);
    if (progress !== undefined && progress !== canary.progress) {
      await getDB().update(deploymentCanaryT).set({ progress }).where(sql`${deploymentCanaryT.id} = ${canary.id}`);
    }
  }));
}

export const canaryDeployment: DashboardDeploymentType = {
  read,

  async withStatus(entries) {
    const deployments = await withInstallationStatus(await read(entries));
    await markMissingFromCatalog(deployments, (deployment) =>
      deployment.type === "canary" ? [deployment.canary.from.specifier, deployment.canary.to.specifier] : []);
    return deployments;
  },

  async requirements(entries) {
    return requirementsForCanaries((await withCanaryRows(entries)).map(({ canary, from, to }) => ({ ...canary, from, to })));
  },

  async phases(entries) {
    const rows = await withCanaryRows(entries);
    return phasesOf(entries, new Map(rows.map(({ entry, canary }) => [entry.id, canary.replicas])));
  },

  async reviewUpdate(entry, input) {
    const [row] = await withCanaryRows([entry]);
    if (!row) {
      return {};
    }
    const { from: fromPatch = {}, to: toPatch = {}, ...rollout } = input.canary ?? {};
    const merged: CanaryPlan = { ...row.canary, ...rollout, from: { ...row.from, ...fromPatch }, to: { ...row.to, ...toPatch } };

    if (fromPatch.specifier || toPatch.specifier) {
      const mismatch = await validateCanaryModelTypes(merged.to.specifier, merged.from.specifier);
      if (mismatch) {
        return { rejected: mismatch };
      }
    }

    const staysEnabled = entry.enabled && input.enabled !== false;
    const changed = staysEnabled ? [...restrictedChanges(fromPatch, row.from), ...restrictedChanges(toPatch, row.to)] : [];
    if (changed.length > 0) {
      return rejectWhileEnabled([...new Set(changed)]);
    }

    const reenabling = input.enabled && !entry.enabled;
    const scalingUp = staysEnabled && rollout.replicas !== undefined && rollout.replicas > row.canary.replicas;
    if (!reenabling && !scalingUp) {
      return {};
    }
    return { mustFit: { requirements: requirementsForCanaries([merged]), replacing: scalingUp ? [row.from.id, row.to.id] : undefined } };
  },

  async update(tx, entry, input) {
    const [canary] = entry.canaryId
      ? await tx.select().from(deploymentCanaryT).where(sql`${deploymentCanaryT.id} = ${entry.canaryId}`).limit(1)
      : [];
    if (!canary || !input.canary) {
      return;
    }
    const { from, to, advance, ...rollout } = input.canary;
    const changes = { ...rollout, advance: advanceChange(canary, rollout.progress, advance) };
    if (hasChanges(changes)) {
      await tx.update(deploymentCanaryT).set(changes).where(sql`${deploymentCanaryT.id} = ${canary.id}`);
    }
    for (const [memberId, patch] of [[canary.fromId, from], [canary.toId, to]] as const) {
      if (hasChanges(patch)) {
        await tx.update(deploymentManagedT).set(patch).where(sql`${deploymentManagedT.id} = ${memberId}`);
      }
    }
  },
};
