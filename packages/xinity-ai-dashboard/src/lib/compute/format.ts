/** Display formatters and shared types for the compute overview page. */

export type LiveMetricsNode = { nodeId: string; utilizationAvg: number; energyWh: number };
export type LiveMetrics = { available: boolean; nodes: LiveMetricsNode[] };

export type GpuInfo = { vendor: string; name: string; vramMb: number };
export type NodeModel = { name: string; driver: string; lifecycleState: string | null; progress: number | null };
export type NodeUsage = { requests: number; failedRequests: number; inputTokens: number; outputTokens: number };
export type NodeSummary = {
  id: string; host: string; machineName: string | null; online: boolean;
  gpuCount: number; gpus: GpuInfo[]; estCapacity: number;
  models: NodeModel[]; usage: NodeUsage;
};
export type ComputeTotals = {
  machinesOnline: number; machinesTotal: number; gpuCount: number;
  requests: number; failedRequests: number; inputTokens: number; outputTokens: number;
};
export type ComputeOverview = { rangeHours: number; nodes: NodeSummary[]; totals: ComputeTotals };
export type HistoryPoint = { t: number; tokens: number; requests: number };
export type ComputeHistory = { rangeHours: number; bucketSeconds: number; series: { nodeId: string; points: HistoryPoint[] }[] };

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return trimZero((value / 1_000_000_000).toFixed(1)) + "B";
  if (value >= 1_000_000) return trimZero((value / 1_000_000).toFixed(1)) + "M";
  if (value >= 1_000) return trimZero((value / 1_000).toFixed(1)) + "k";
  return String(Math.round(value));
}

/** Energy is always an estimate; callers prefix the value with "≈". */
export function formatEnergy(wh: number): string {
  if (wh >= 1_000_000) return trimZero((wh / 1_000_000).toFixed(1)) + " MWh";
  if (wh >= 1_000) return trimZero((wh / 1_000).toFixed(1)) + " kWh";
  return Math.round(wh) + " Wh";
}

export function formatPercent(value: number): string {
  if (value >= 99.95) return "100%";
  return trimZero(value.toFixed(1)) + "%";
}

export function formatRelativeTime(epochMs: number, nowMs: number): string {
  const minutes = Math.round((nowMs - epochMs) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Groups identical GPUs into "2× NVIDIA H100 80GB HBM3". */
export function gpuSummary(gpus: { name: string }[]): string {
  const counts = new Map<string, number>();
  for (const gpu of gpus) {
    counts.set(gpu.name, (counts.get(gpu.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, n]) => (n > 1 ? `${n}× ${name}` : name))
    .join(" · ");
}

function trimZero(formatted: string): string {
  return formatted.replace(/\.0$/, "");
}
