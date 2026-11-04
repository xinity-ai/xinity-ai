import { isDeepStrictEqual } from "node:util";
import { deploymentCanaryT, deploymentManagedT, deploymentT, sql, type Deployment, type DeploymentManaged } from "common-db";
import type { DeploymentType } from "common-env";
import { MIN_CANARY_REPLICAS, type CanaryMemberInput, type RolloutTarget } from "$lib/orpc/dtos/model.dto";
import { getDB } from "$lib/server/db";
import { resolveSchedulable } from "$lib/server/lib/models/model-catalog";
import type { VariantHandlers } from "$lib/util";
import { modelTypeMismatch, storedAdvance, withCanaryRows } from "./canary-deployment";
import { uninstallOwnedBy } from "./deployment-reads";
import type { CapacityNeed, Transaction } from "./deployment-types";
import { createManaged } from "./managed-deployment";
import { requirementsForCanaries, requirementsForManaged } from "./requirements";

type CanaryTarget = Extract<RolloutTarget, { type: "canary" }>;
type ManagedTarget = Extract<RolloutTarget, { type: "managed" }>;

/** Why the rollout cannot happen, or the models it needs in the catalog, what has to fit, and how to make it. */
export type RolloutReview =
  | { rejected: string }
  | { models: string[]; mustFit: CapacityNeed; apply: (tx: Transaction) => Promise<void> };

// The new model runs like the one it replaces unless the rollout says otherwise.
const newMemberOf = (from: DeploymentManaged, to: CanaryMemberInput) => ({
  specifier: to.specifier,
  replicas: from.replicas,
  kvCacheSize: to.kvCacheSize ?? null,
  preferredDriver: to.preferredDriver ?? from.preferredDriver,
  settings: to.settings ?? from.settings,
});

async function engineOf({ specifier, preferredDriver }: Pick<DeploymentManaged, "specifier" | "preferredDriver">) {
  const resolution = await resolveSchedulable(specifier, preferredDriver);
  return resolution.status === "found" ? resolution.model.driver : preferredDriver;
}

async function sameModelIssue(from: DeploymentManaged, to: ReturnType<typeof newMemberOf>): Promise<string | null> {
  if (from.specifier !== to.specifier) {
    return null;
  }
  const [fromEngine, toEngine] = await Promise.all([engineOf(from), engineOf(to)]);
  if (fromEngine === "ollama" && toEngine === "ollama") {
    return "Ollama sizes a model's cache itself and serves one copy of it per machine, so a rollout to the same model on Ollama has nothing to change";
  }
  if (fromEngine === toEngine && from.kvCacheSize === to.kvCacheSize && isDeepStrictEqual(from.settings, to.settings)) {
    return "The rollout changes nothing: it names the model the deployment serves, with the same engine, KV cache and settings";
  }
  return null;
}

async function managedRowOf(entry: Deployment) {
  const [row] = await getDB().select().from(deploymentManagedT).where(sql`${deploymentManagedT.id} = ${entry.managedId}`).limit(1);
  return row;
}

async function startCanary(target: CanaryTarget, entry: Deployment): Promise<RolloutReview> {
  const from = await managedRowOf(entry);
  if (!from) {
    return { rejected: "The deployment has no model to roll out from" };
  }
  const mismatch = await modelTypeMismatch(target.canary.to.specifier, from.specifier);
  if (mismatch) {
    return { rejected: mismatch };
  }
  const { progress, advance } = target.canary;
  const to = newMemberOf(from, target.canary.to);
  const sameModel = await sameModelIssue(from, to);
  if (sameModel) {
    return { rejected: sameModel };
  }
  const replicas = Math.max(MIN_CANARY_REPLICAS, from.replicas);
  return {
    models: [to.specifier],
    mustFit: {
      requirements: requirementsForCanaries([{ replicas, progress, from, to: { id: "rollout-draft", ...to } }]),
      changing: [from.id],
    },
    apply: async (tx) => {
      const toId = await createManaged(tx, to);
      const [canary] = await tx.insert(deploymentCanaryT)
        .values({ fromId: from.id, toId, replicas, progress, advance: storedAdvance(advance, progress) })
        .returning({ id: deploymentCanaryT.id });
      if (!canary) {
        throw new Error("Insert into deploymentCanaryT returned no row");
      }
      await tx.update(deploymentT).set({ type: "canary", managedId: null, canaryId: canary.id }).where(sql`${deploymentT.id} = ${entry.id}`);
    },
  };
}

async function switchModel({ managed }: ManagedTarget, entry: Deployment): Promise<RolloutReview> {
  if (!("to" in managed)) {
    return { rejected: "A managed deployment has no rollout to end. Name the model that replaces its current one in `to`" };
  }
  const from = await managedRowOf(entry);
  if (!from) {
    return { rejected: "The deployment has no model to replace" };
  }
  const mismatch = await modelTypeMismatch(managed.to.specifier, from.specifier);
  if (mismatch) {
    return { rejected: mismatch };
  }
  const to = newMemberOf(from, managed.to);
  return {
    models: [to.specifier],
    mustFit: { requirements: requirementsForManaged([{ id: "switch-draft", ...to }]), changing: [from.id] },
    apply: async (tx) => {
      const managedId = await createManaged(tx, to);
      await tx.update(deploymentT).set({ managedId }).where(sql`${deploymentT.id} = ${entry.id}`);
      await uninstallOwnedBy(tx, [from.id]);
    },
  };
}

const OTHER_MEMBER = { from: "to", to: "from" } as const;

async function endCanary({ managed }: ManagedTarget, entry: Deployment): Promise<RolloutReview> {
  if (!("keep" in managed)) {
    return { rejected: "A rollout ends on one of its two models. Name it in `keep`" };
  }
  const [row] = await withCanaryRows([entry]);
  if (!row) {
    return { rejected: "The deployment has no rollout to end" };
  }
  const kept = row[managed.keep];
  const dropped = row[OTHER_MEMBER[managed.keep]];
  return {
    models: [],
    mustFit: { requirements: requirementsForManaged([{ ...kept, replicas: row.canary.replicas }]), changing: [row.from.id, row.to.id] },
    apply: async (tx) => {
      await tx.update(deploymentManagedT).set({ replicas: row.canary.replicas }).where(sql`${deploymentManagedT.id} = ${kept.id}`);
      await tx.update(deploymentT).set({ type: "managed", managedId: kept.id, canaryId: null }).where(sql`${deploymentT.id} = ${entry.id}`);
      await tx.delete(deploymentCanaryT).where(sql`${deploymentCanaryT.id} = ${row.canary.id}`);
      await uninstallOwnedBy(tx, [dropped.id]);
    },
  };
}

// Which type each type of deployment can become through a rollout, by its current type.
const ROLLOUTS: { [T in DeploymentType]: Partial<VariantHandlers<RolloutTarget, Promise<RolloutReview>, [Deployment]>> } = {
  legacy: {},
  managed: { canary: startCanary, managed: switchModel },
  canary: { managed: endCanary },
};

export function reviewRollout(entry: Deployment, target: RolloutTarget): Promise<RolloutReview> {
  // TypeScript cannot relate the handler for `target.type` to `target`, though the mapped type guarantees it.
  const rollout = ROLLOUTS[entry.type][target.type] as ((target: RolloutTarget, entry: Deployment) => Promise<RolloutReview>) | undefined;
  if (!rollout) {
    return Promise.resolve({ rejected: `A ${entry.type} deployment cannot become a ${target.type} deployment through a rollout` });
  }
  return rollout(target, entry);
}
