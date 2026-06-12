/**
 * Pure helpers for the fleet overview API. Kept free of $lib/server imports so
 * they are unit-testable with plain `bun test`.
 */

/** Chart bucket width scaled to the requested range, keeping point counts reasonable. */
export function pickBucketSeconds(rangeHours: number): number {
  if (rangeHours <= 6) return 15 * 60;
  if (rangeHours <= 24) return 30 * 60;
  if (rangeHours <= 7 * 24) return 2 * 60 * 60;
  return 24 * 60 * 60;
}

export type HistoryUsageRow = {
  nodeId: string;
  t: number;
  tokens: number;
  requests: number;
};

export type HistoryPoint = {
  t: number;
  tokens: number;
  requests: number;
};

export type HistorySeries = { nodeId: string; points: HistoryPoint[] };

/** Builds per-node time series from token/request usage rows. */
export function mergeHistorySeries(usageRows: HistoryUsageRow[]): HistorySeries[] {
  const byNode = new Map<string, Map<number, HistoryPoint>>();

  for (const row of usageRows) {
    let points = byNode.get(row.nodeId);
    if (!points) {
      points = new Map();
      byNode.set(row.nodeId, points);
    }
    points.set(row.t, { t: row.t, tokens: row.tokens, requests: row.requests });
  }

  return [...byNode.entries()].map(([nodeId, points]) => ({
    nodeId,
    points: [...points.values()].sort((a, b) => a.t - b.t),
  }));
}
