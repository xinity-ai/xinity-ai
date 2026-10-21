/**
 * Pure helpers for the compute overview API. Kept free of $lib/server imports so
 * they are unit-testable with plain `bun test`.
 */

export type BucketUnit = "hour" | "day";

/** Nominal width; a local day around a DST switch is 23 or 25 hours. */
export const BUCKET_SECONDS: Record<BucketUnit, number> = {
  hour: 60 * 60,
  day: 24 * 60 * 60,
};

export function pickBucketUnit(rangeHours: number): BucketUnit {
  return rangeHours <= 24 ? "hour" : "day";
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
