export const REPLICA_PHASE_ORDER = ["ready", "downloading", "installing", "scheduling", "failed"] as const;
export type ReplicaPhase = (typeof REPLICA_PHASE_ORDER)[number];

/** Phase order plus the synthetic slot for a replica the orchestrator has not placed yet. */
export const SLOT_PHASE_ORDER = [...REPLICA_PHASE_ORDER, "unscheduled"] as const;
export type SlotPhase = (typeof SLOT_PHASE_ORDER)[number];

export type ObservedReplica = { phase: ReplicaPhase; node?: string | null; error?: string | null };

export type ReplicaSlots = {
  observed: ObservedReplica[];
  /** Desired replicas with no installation row behind them. */
  missing: number;
  /** What the card renders, so dot count always matches the replica badge. */
  total: number;
};

/**
 * Reconciles the desired replica count against the installations that actually exist.
 *
 * Installations are the only thing the status query can see, so without this a desired replica
 * that was never placed renders as nothing at all and the deployment looks fully provisioned.
 */
export function replicaSlots(desired: number, observed: ObservedReplica[] | undefined): ReplicaSlots {
  const present = observed ?? [];
  // Scale-down leaves more installations than desired until the uninstalls land, and those
  // replicas are still serving, so show every one of them rather than clamping to `desired`.
  const missing = Math.max(0, desired - present.length);
  return { observed: present, missing, total: present.length + missing };
}

/** Counts per slot phase in display order, omitting phases with no slots. */
export function replicaSlotCounts(slots: ReplicaSlots): Array<[SlotPhase, number]> {
  const counts = new Map<SlotPhase, number>();
  for (const replica of slots.observed) {
    const phase: SlotPhase = replica.phase;
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  if (slots.missing > 0) {
    counts.set("unscheduled", slots.missing);
  }
  return SLOT_PHASE_ORDER.filter(phase => counts.has(phase)).map(phase => [phase, counts.get(phase)!]);
}
