import { describe, test, expect } from "bun:test";
import { mergeHistorySeries } from "./compute";

describe("mergeHistorySeries", () => {
  test("builds per-node series sorted by time", () => {
    const series = mergeHistorySeries([
      { nodeId: "a", t: 1800, tokens: 1000, requests: 4 },
      { nodeId: "a", t: 0, tokens: 500, requests: 2 },
      { nodeId: "b", t: 0, tokens: 200, requests: 1 },
    ]);

    const a = series.find((s) => s.nodeId === "a")!;
    expect(a.points.map((p) => p.t)).toEqual([0, 1800]);
    expect(a.points[1]).toEqual({ t: 1800, tokens: 1000, requests: 4 });

    const b = series.find((s) => s.nodeId === "b")!;
    expect(b.points[0]).toEqual({ t: 0, tokens: 200, requests: 1 });
  });
});
