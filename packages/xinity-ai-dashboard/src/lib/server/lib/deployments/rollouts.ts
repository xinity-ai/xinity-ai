import { deploymentCanaryT, deploymentManagedT, deploymentT, sql, type Deployment, type DeploymentManaged } from "common-db";
import type { DeploymentType } from "common-env";
import { MIN_CANARY_REPLICAS, type RolloutTarget } from "$lib/orpc/dtos/model.dto";
import { getDB } from "$lib/server/db";
import type { VariantHandlers } from "$lib/util";
import { storedAdvance, validateCanaryModelTypes, withCanaryRows } from "./canary-deployment";
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

// The new member runs like the one it replaces unless the rollout says otherwise.
const newMemberOf = (from: DeploymentManaged, { canary: { to } }: CanaryTarget) => ({
  specifier: to.specifier,
  replicas: from.replicas,
  kvCacheSize: to.kvCacheSize ?? null,
  preferredDriver: to.preferredDriver ?? from.preferredDriver,
  settings: to.settings ?? from.settings,
});

async function startCanary(target: CanaryTarget, entry: Deployment): Promise<RolloutReview> {
  const [from] = await getDB().select().from(deploymentManagedT).where(sql`${deploymentManagedT.id} = ${entry.managedId}`).limit(1);
  if (!from) {
    return { rejected: "The deployment has no model to roll out from" };
  }
  const mismatch = await validateCanaryModelTypes(target.canary.to.specifier, from.specifier);
  if (mismatch) {
    return { rejected: mismatch };
  }
  const { progress, advance } = target.canary;
  const to = newMemberOf(from, target);
  const replicas = Math.max(MIN_CANARY_REPLICAS, from.replicas);
  return {
    models: [to.specifier],
    mustFit: {
      requirements: requirementsForCanaries([{ replicas, progress, from, to: { id: "rollout-draft", ...to } }]),
      replacing: [from.id],
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

// A row that is replaced stays, with its installations marked deleted. Deleting the row would delete its
// installation rows before the daemons saw them removed.

const OTHER_MEMBER = { from: "to", to: "from" } as const;

async function endCanary({ managed: { keep } }: ManagedTarget, entry: Deployment): Promise<RolloutReview> {
  const [row] = await withCanaryRows([entry]);
  if (!row) {
    return { rejected: "The deployment has no rollout to end" };
  }
  const kept = row[keep];
  const dropped = row[OTHER_MEMBER[keep]];
  return {
    models: [],
    mustFit: { requirements: requirementsForManaged([{ ...kept, replicas: row.canary.replicas }]), replacing: [row.from.id, row.to.id] },
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
  managed: { canary: startCanary },
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
