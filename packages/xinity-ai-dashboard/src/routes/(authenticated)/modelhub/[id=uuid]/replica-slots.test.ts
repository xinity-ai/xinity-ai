import { describe, test, expect } from "bun:test";
import { modelSlots, replicaSlotCounts, type ObservedReplica } from "./replica-slots";

function ready(count: number, specifier = "model-a"): ObservedReplica[] {
  return Array.from({ length: count }, () => ({ phase: "ready", specifier }));
}

const wantA = (replicas: number) => [{ specifier: "model-a", replicas }];

describe("modelSlots", () => {
  test("reports no shortfall when every wanted replica is installed", () => {
    const [slots] = modelSlots(wantA(3), ready(3));
    expect(slots!.missing).toBe(0);
    expect(slots!.observed).toHaveLength(3);
  });

  test("counts the shortfall of a model", () => {
    expect(modelSlots(wantA(4), ready(3))[0]!.missing).toBe(1);
  });

  test("treats a model with no installations as entirely unscheduled", () => {
    const [slots] = modelSlots(wantA(2), []);
    expect(slots!.missing).toBe(2);
    expect(slots!.observed).toEqual([]);
  });

  test("keeps every installation during scale-down rather than clamping to what is wanted", () => {
    const [slots] = modelSlots(wantA(2), ready(5));
    expect(slots!.missing).toBe(0);
    expect(slots!.observed).toHaveLength(5);
  });

  test("puts a missing replica under the model that lacks it, not the one listed last", () => {
    const wanted = [{ specifier: "new", replicas: 1 }, { specifier: "old", replicas: 2 }];
    const slots = modelSlots(wanted, [...ready(1, "old"), ...ready(1, "new")]);
    expect(slots.map(({ specifier, missing }) => [specifier, missing])).toEqual([["new", 0], ["old", 1]]);
  });

  test("keeps the two sides of a rollout apart when both serve the same model", () => {
    const wanted = [{ specifier: "model-a", side: "to" as const, replicas: 1 }, { specifier: "model-a", side: "from" as const, replicas: 1 }];
    const slots = modelSlots(wanted, [{ phase: "ready", specifier: "model-a", side: "from" }]);
    expect(slots.map(({ side, observed, missing }) => [side, observed.length, missing])).toEqual([["to", 0, 1], ["from", 1, 0]]);
  });

  test("still shows a model that is no longer wanted while its installations remain", () => {
    const slots = modelSlots(wantA(1), [...ready(1), ...ready(1, "retired")]);
    expect(slots.map(({ specifier, observed, missing }) => [specifier, observed.length, missing])).toEqual([
      ["model-a", 1, 0],
      ["retired", 1, 0],
    ]);
  });
});

describe("replicaSlotCounts", () => {
  test("groups observed phases in display order", () => {
    const observed: ObservedReplica[] = [
      { phase: "failed", specifier: "model-a" }, { phase: "ready", specifier: "model-a" },
      { phase: "downloading", specifier: "model-a" }, { phase: "ready", specifier: "model-a" },
    ];
    expect(replicaSlotCounts(modelSlots(wantA(4), observed))).toEqual([
      ["ready", 2], ["downloading", 1], ["failed", 1],
    ]);
  });

  test("appends unscheduled slots last, summed over the models", () => {
    const wanted = [{ specifier: "new", replicas: 2 }, { specifier: "old", replicas: 3 }];
    expect(replicaSlotCounts(modelSlots(wanted, [...ready(1, "new"), ...ready(2, "old")]))).toEqual([
      ["ready", 3], ["unscheduled", 2],
    ]);
  });

  test("omits unscheduled entirely when nothing is missing", () => {
    expect(replicaSlotCounts(modelSlots(wantA(2), ready(2)))).toEqual([["ready", 2]]);
  });
});
