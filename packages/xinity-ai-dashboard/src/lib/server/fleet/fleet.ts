/**
 * Pure helpers for the fleet overview API. Kept free of $lib/server imports so
 * they are unit-testable with plain `bun test`.
 */

/** A node counts as online when its daemon heartbeat is fresher than this (3 missed 5-minute flushes). */
export const HEARTBEAT_FRESH_MS = 15 * 60 * 1000;

/** Nodes that predate telemetry (lastSeenAt null) fall back to the `available` flag alone. */
export function isNodeOnline(available: boolean, lastSeenAt: Date | null, nowMs: number): boolean {
  if (!available) return false;
  if (lastSeenAt === null) return true;
  return nowMs - lastSeenAt.getTime() <= HEARTBEAT_FRESH_MS;
}

/** Chart bucket width scaled to the requested range, keeping point counts reasonable. */
export function pickBucketSeconds(rangeHours: number): number {
  if (rangeHours <= 6) return 15 * 60;
  if (rangeHours <= 24) return 30 * 60;
  if (rangeHours <= 7 * 24) return 2 * 60 * 60;
  return 24 * 60 * 60;
}

export type HistoryMetricRow = {
  nodeId: string;
  /** Bucket start in epoch seconds. */
  t: number;
  utilizationAvg: number;
  energyWh: number;
};

export type HistoryUsageRow = {
  nodeId: string;
  t: number;
  tokens: number;
  requests: number;
};

export type HistoryPoint = {
  t: number;
  /** Null for buckets where the node reported no metrics (e.g. daemon offline). */
  utilizationAvg: number | null;
  energyWh: number;
  tokens: number;
  requests: number;
};

export type HistorySeries = { nodeId: string; points: HistoryPoint[] };

/** Merges utilization buckets (node_metric) and token buckets (usage_event) into one per-node time series. */
export function mergeHistorySeries(
  metricRows: HistoryMetricRow[],
  usageRows: HistoryUsageRow[],
): HistorySeries[] {
  const byNode = new Map<string, Map<number, HistoryPoint>>();

  const pointFor = (nodeId: string, t: number): HistoryPoint => {
    let points = byNode.get(nodeId);
    if (!points) {
      points = new Map();
      byNode.set(nodeId, points);
    }
    let point = points.get(t);
    if (!point) {
      point = { t, utilizationAvg: null, energyWh: 0, tokens: 0, requests: 0 };
      points.set(t, point);
    }
    return point;
  };

  for (const row of metricRows) {
    const point = pointFor(row.nodeId, row.t);
    point.utilizationAvg = row.utilizationAvg;
    point.energyWh = row.energyWh;
  }
  for (const row of usageRows) {
    const point = pointFor(row.nodeId, row.t);
    point.tokens = row.tokens;
    point.requests = row.requests;
  }

  return [...byNode.entries()].map(([nodeId, points]) => ({
    nodeId,
    points: [...points.values()].sort((a, b) => a.t - b.t),
  }));
}
