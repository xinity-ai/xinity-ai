import { describe, test, expect } from "bun:test";
import {
  HEARTBEAT_FRESH_MS,
  isNodeOnline,
  pickBucketSeconds,
  mergeHistorySeries,
} from "./fleet";

describe("isNodeOnline", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");

  test("offline when unavailable regardless of heartbeat", () => {
    expect(isNodeOnline(false, new Date(now), now)).toBe(false);
  });

  test("online with a fresh heartbeat", () => {
    expect(isNodeOnline(true, new Date(now - HEARTBEAT_FRESH_MS + 1000), now)).toBe(true);
  });

  test("offline when the heartbeat is stale", () => {
    expect(isNodeOnline(true, new Date(now - HEARTBEAT_FRESH_MS - 1000), now)).toBe(false);
  });

  test("falls back to available flag for nodes without telemetry", () => {
    expect(isNodeOnline(true, null, now)).toBe(true);
    expect(isNodeOnline(false, null, now)).toBe(false);
  });
});

describe("pickBucketSeconds", () => {
  test("scales bucket width with range", () => {
    expect(pickBucketSeconds(1)).toBe(900);
    expect(pickBucketSeconds(24)).toBe(1800);
    expect(pickBucketSeconds(72)).toBe(7200);
    expect(pickBucketSeconds(24 * 30)).toBe(86400);
  });
});

describe("mergeHistorySeries", () => {
  test("merges metric and usage buckets per node and sorts by time", () => {
    const series = mergeHistorySeries(
      [
        { nodeId: "a", t: 1800, utilizationAvg: 50, energyWh: 10 },
        { nodeId: "a", t: 0, utilizationAvg: 20, energyWh: 5 },
      ],
      [
        { nodeId: "a", t: 1800, tokens: 1000, requests: 4 },
        { nodeId: "b", t: 0, tokens: 200, requests: 1 },
      ],
    );

    const a = series.find((s) => s.nodeId === "a")!;
    expect(a.points.map((p) => p.t)).toEqual([0, 1800]);
    expect(a.points[1]).toEqual({ t: 1800, utilizationAvg: 50, energyWh: 10, tokens: 1000, requests: 4 });
    // Bucket with metrics but no requests keeps zero tokens
    expect(a.points[0]!.tokens).toBe(0);

    // Node with usage but no metrics gets a null utilization, not zero
    const b = series.find((s) => s.nodeId === "b")!;
    expect(b.points[0]!.utilizationAvg).toBeNull();
    expect(b.points[0]!.tokens).toBe(200);
  });

  test("returns empty array for no data", () => {
    expect(mergeHistorySeries([], [])).toEqual([]);
  });
});
