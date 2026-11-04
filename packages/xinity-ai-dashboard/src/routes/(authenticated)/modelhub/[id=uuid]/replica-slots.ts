import type { CANARY_MEMBERS } from "$lib/orpc/dtos/model.dto";

export const REPLICA_PHASE_ORDER = ["ready", "downloading", "installing", "scheduling", "failed"] as const;
export type ReplicaPhase = (typeof REPLICA_PHASE_ORDER)[number];

export const SLOT_PHASE_ORDER = [...REPLICA_PHASE_ORDER, "unscheduled"] as const;
export type SlotPhase = (typeof SLOT_PHASE_ORDER)[number];

export type ReplicaGroup = { specifier: string; side?: (typeof CANARY_MEMBERS)[number] };

export type ObservedReplica = ReplicaGroup & { phase: ReplicaPhase };

export type ModelSlots<R extends ObservedReplica> = ReplicaGroup & {
  observed: R[];
  /** Wanted replicas of this group with no installation behind them. */
  missing: number;
};

// Both sides of a rollout may serve the same model, so a side outweighs the model.
const keyOf = ({ specifier, side }: ReplicaGroup) => side ?? specifier;

export function modelSlots<R extends ObservedReplica>(wanted: (ReplicaGroup & { replicas: number })[], observed: R[]): ModelSlots<R>[] {
  // A model no longer wanted keeps serving until its installations are removed, so it still gets a group.
  const groups = new Map([...wanted, ...observed].map(({ specifier, side }) => [keyOf({ specifier, side }), { specifier, side }]));
  return [...groups].map(([key, group]) => {
    const served = observed.filter((replica) => keyOf(replica) === key);
    const replicas = wanted.find((model) => keyOf(model) === key)?.replicas ?? 0;
    // Scale-down leaves more installations than wanted until the uninstalls land, and those still serve.
    return { ...group, observed: served, missing: Math.max(0, replicas - served.length) };
  });
}

export function replicaSlotCounts(models: ModelSlots<ObservedReplica>[]): Array<[SlotPhase, number]> {
  const counts = new Map<SlotPhase, number>();
  for (const { observed, missing } of models) {
    for (const replica of observed) {
      counts.set(replica.phase, (counts.get(replica.phase) ?? 0) + 1);
    }
    if (missing > 0) {
      counts.set("unscheduled", (counts.get("unscheduled") ?? 0) + missing);
    }
  }
  return SLOT_PHASE_ORDER.filter((phase) => counts.has(phase)).map((phase) => [phase, counts.get(phase)!]);
}
