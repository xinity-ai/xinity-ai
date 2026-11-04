import { describe, test, expect } from "bun:test";
import { replicaSlots, replicaSlotCounts, type ObservedReplica } from "./replica-slots";

function ready(count: number): ObservedReplica[] {
  return Array.from({ length: count }, () => ({ phase: "ready", node: "node-1", error: null }));
}

describe("replicaSlots", () => {
  test("reports no shortfall when every desired replica is installed", () => {
    const slots = replicaSlots(3, ready(3));
    expect(slots.missing).toBe(0);
    expect(slots.total).toBe(3);
    expect(slots.observed).toHaveLength(3);
  });

  test("counts the shortfall so the total matches the replica badge", () => {
    const slots = replicaSlots(4, ready(3));
    expect(slots.missing).toBe(1);
    expect(slots.total).toBe(4);
  });

  test("treats a deployment with no installations as entirely unscheduled", () => {
    const slots = replicaSlots(2, undefined);
    expect(slots.missing).toBe(2);
    expect(slots.total).toBe(2);
    expect(slots.observed).toEqual([]);
  });

  test("keeps every installation during scale-down rather than clamping to desired", () => {
    const slots = replicaSlots(2, ready(5));
    expect(slots.missing).toBe(0);
    expect(slots.total).toBe(5);
    expect(slots.observed).toHaveLength(5);
  });

  test("never reports a negative shortfall", () => {
    expect(replicaSlots(0, ready(3)).missing).toBe(0);
  });

  test("a single desired replica with nothing installed still yields one slot", () => {
    const slots = replicaSlots(1, []);
    expect(slots.missing).toBe(1);
    expect(slots.total).toBe(1);
  });
});

describe("replicaSlotCounts", () => {
  test("groups observed phases in display order", () => {
    const observed: ObservedReplica[] = [
      { phase: "failed" }, { phase: "ready" }, { phase: "downloading" }, { phase: "ready" },
    ];
    expect(replicaSlotCounts(replicaSlots(4, observed))).toEqual([
      ["ready", 2], ["downloading", 1], ["failed", 1],
    ]);
  });

  test("appends unscheduled slots last so the shortfall reads as the tail", () => {
    expect(replicaSlotCounts(replicaSlots(10, ready(6)))).toEqual([
      ["ready", 6], ["unscheduled", 4],
    ]);
  });

  test("omits unscheduled entirely when nothing is missing", () => {
    expect(replicaSlotCounts(replicaSlots(2, ready(2)))).toEqual([["ready", 2]]);
  });

  test("counts sum to the rendered total", () => {
    const slots = replicaSlots(9, [...ready(3), { phase: "installing" }]);
    const sum = replicaSlotCounts(slots).reduce((acc, [, n]) => acc + n, 0);
    expect(sum).toBe(slots.total);
    expect(sum).toBe(9);
  });
});
