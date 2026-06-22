import { describe, test, expect } from "bun:test";
import { pickBucketSeconds, mergeHistorySeries } from "./compute";

describe("pickBucketSeconds", () => {
  test("scales bucket width with range", () => {
    expect(pickBucketSeconds(1)).toBe(900);
    expect(pickBucketSeconds(24)).toBe(1800);
    expect(pickBucketSeconds(72)).toBe(7200);
    expect(pickBucketSeconds(24 * 30)).toBe(86400);
  });
});

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

  test("returns empty array for no data", () => {
    expect(mergeHistorySeries([])).toEqual([]);
  });
});
