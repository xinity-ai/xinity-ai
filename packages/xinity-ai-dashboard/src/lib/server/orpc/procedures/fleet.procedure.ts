import { rootOs, withInstanceAdmin } from "../root";
import {
  aiNodeT,
  modelInstallationT,
  modelInstallationStateT,
  usageEventT,
  sql,
  and,
  count,
  eq,
  gte,
  isNull,
  isNotNull,
} from "common-db";
import { getDB } from "$lib/server/db";
import { mergeHistorySeries, pickBucketSeconds } from "$lib/server/fleet/fleet";
import { serverEnv } from "$lib/server/serverenv";
import z from "zod";

const tags = ["Fleet"];


const RangeInputSchema = z.object({
  rangeHours: z.coerce.number().int().min(1).max(90 * 24).default(24),
});

const GpuInfoSchema = z.object({
  vendor: z.string(),
  name: z.string(),
  vramMb: z.number(),
});

const FleetModelSchema = z.object({
  name: z.string(),
  driver: z.string(),
  lifecycleState: z.string().nullable(),
  progress: z.number().nullable(),
});

const FleetUsageSchema = z.object({
  requests: z.number(),
  failedRequests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

const FleetNodeSchema = z.object({
  id: z.string(),
  host: z.string(),
  machineName: z.string().nullable(),
  online: z.boolean(),
  gpuCount: z.number(),
  gpus: z.array(GpuInfoSchema),
  estCapacity: z.number(),
  models: z.array(FleetModelSchema),
  usage: FleetUsageSchema,
});

const FleetTotalsSchema = z.object({
  machinesOnline: z.number(),
  machinesTotal: z.number(),
  gpuCount: z.number(),
  requests: z.number(),
  failedRequests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

const FleetOverviewOutput = z.object({
  rangeHours: z.number(),
  nodes: z.array(FleetNodeSchema),
  totals: FleetTotalsSchema,
});
export type FleetOverview = z.infer<typeof FleetOverviewOutput>;
export type FleetNode = z.infer<typeof FleetNodeSchema>;

const HistoryPointSchema = z.object({
  /** Bucket start in epoch seconds. */
  t: z.number(),
  tokens: z.number(),
  requests: z.number(),
});

const FleetHistoryOutput = z.object({
  rangeHours: z.number(),
  bucketSeconds: z.number(),
  series: z.array(z.object({
    nodeId: z.string(),
    points: z.array(HistoryPointSchema),
  })),
});
export type FleetHistory = z.infer<typeof FleetHistoryOutput>;

const sumNumber = (column: unknown) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

export async function buildFleetOverview(rangeHours: number): Promise<FleetOverview> {
  const since = new Date(Date.now() - rangeHours * 60 * 60 * 1000);
  const db = getDB();

  const [nodes, installations, usageRows] = await Promise.all([
    db.select({
      id: aiNodeT.id,
      host: aiNodeT.host,
      machineName: aiNodeT.machineName,
      available: aiNodeT.available,
      gpuCount: aiNodeT.gpuCount,
      gpus: aiNodeT.gpus,
      estCapacity: aiNodeT.estCapacity,
    }).from(aiNodeT).where(isNull(aiNodeT.deletedAt)),

    db.select({
      nodeId: modelInstallationT.nodeId,
      specifier: modelInstallationT.specifier,
      model: modelInstallationT.model,
      driver: modelInstallationT.driver,
      lifecycleState: modelInstallationStateT.lifecycleState,
      progress: modelInstallationStateT.progress,
    }).from(modelInstallationT)
      .leftJoin(modelInstallationStateT, eq(modelInstallationStateT.id, modelInstallationT.id))
      .where(isNull(modelInstallationT.deletedAt)),

    db.select({
      nodeId: usageEventT.nodeId,
      requests: count(),
      failedRequests: sql<number>`count(*) filter (where not ${usageEventT.success})`.mapWith(Number),
      inputTokens: sumNumber(usageEventT.inputTokens),
      outputTokens: sumNumber(usageEventT.outputTokens),
    }).from(usageEventT)
      .innerJoin(aiNodeT, and(eq(aiNodeT.id, usageEventT.nodeId), isNull(aiNodeT.deletedAt)))
      .where(and(gte(usageEventT.createdAt, since), isNotNull(usageEventT.nodeId)))
      .groupBy(usageEventT.nodeId),
  ]);

  const usageByNode = new Map(usageRows.map((r) => [r.nodeId, r]));
  const modelsByNode = new Map<string, typeof installations>();
  for (const inst of installations) {
    const list = modelsByNode.get(inst.nodeId) ?? [];
    list.push(inst);
    modelsByNode.set(inst.nodeId, list);
  }

  const emptyUsage = { requests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0 };

  const fleetNodes: FleetNode[] = nodes.map((node) => {
    const usage = usageByNode.get(node.id);
    return {
      id: node.id,
      host: node.host,
      machineName: node.machineName,
      online: node.available,
      gpuCount: node.gpuCount,
      gpus: node.gpus,
      estCapacity: node.estCapacity,
      models: (modelsByNode.get(node.id) ?? []).map((m) => ({
        name: m.specifier ?? m.model,
        driver: m.driver,
        lifecycleState: m.lifecycleState,
        progress: m.progress,
      })),
      usage: usage
        ? {
            requests: usage.requests,
            failedRequests: usage.failedRequests,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          }
        : emptyUsage,
    };
  });

  const totalUsage = usageRows.reduce(
    (acc, r) => ({
      requests: acc.requests + r.requests,
      failedRequests: acc.failedRequests + r.failedRequests,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
    }),
    emptyUsage,
  );

  return {
    rangeHours,
    nodes: fleetNodes,
    totals: {
      machinesOnline: fleetNodes.filter((n) => n.online).length,
      machinesTotal: fleetNodes.length,
      gpuCount: fleetNodes.reduce((acc, n) => acc + n.gpuCount, 0),
      ...totalUsage,
    },
  };
}

export async function buildFleetHistory(rangeHours: number): Promise<FleetHistory> {
  const bucketSeconds = pickBucketSeconds(rangeHours);
  const since = new Date(Date.now() - rangeHours * 60 * 60 * 1000);
  const db = getDB();

  // bucketSeconds is server-derived (pickBucketSeconds), never user input, and is
  // inlined as a literal so the SELECT and GROUP BY expressions are textually
  // identical — with bound parameters Postgres treats them as different expressions.
  const width = sql.raw(String(bucketSeconds));
  const usageBucket = sql`floor(extract(epoch from ${usageEventT.createdAt}) / ${width}) * ${width}`;

  // Join against ai_node so series from deleted machines (e.g. cleaned-up test
  // nodes whose events linger) don't appear as ghost entries in the chart.
  const usageRows = await db.select({
    nodeId: sql<string>`${usageEventT.nodeId}`,
    t: sql<number>`${usageBucket}`.mapWith(Number),
    tokens: sql<number>`coalesce(sum(${usageEventT.inputTokens} + ${usageEventT.outputTokens}), 0)`.mapWith(Number),
    requests: count(),
  }).from(usageEventT)
    .innerJoin(aiNodeT, and(eq(aiNodeT.id, usageEventT.nodeId), isNull(aiNodeT.deletedAt)))
    .where(and(gte(usageEventT.createdAt, since), isNotNull(usageEventT.nodeId)))
    .groupBy(usageEventT.nodeId, usageBucket);

  return {
    rangeHours,
    bucketSeconds,
    series: mergeHistorySeries(usageRows),
  };
}

const fleetOverview = rootOs
  .use(withInstanceAdmin)
  .route({
    path: "/overview", method: "GET", tags,
    summary: "Get Fleet Overview",
    description: "Returns all compute nodes with hardware inventory, liveness, installed models, and request statistics",
  })
  .input(RangeInputSchema.optional())
  .output(FleetOverviewOutput)
  .handler(({ input }) => buildFleetOverview(input?.rangeHours ?? 24));

const fleetHistory = rootOs
  .use(withInstanceAdmin)
  .route({
    path: "/history", method: "GET", tags,
    summary: "Get Fleet History",
    description: "Returns bucketed per-node time series of token throughput for charts",
  })
  .input(RangeInputSchema.optional())
  .output(FleetHistoryOutput)
  .handler(({ input }) => buildFleetHistory(input?.rangeHours ?? 24));

// ─── Live metrics from Prometheus ────────────────────────────────────────────

type PromVectorResult = { metric: Record<string, string>; value: [number, string] };

async function queryPrometheusInstant(prometheusUrl: string, query: string): Promise<PromVectorResult[]> {
  const url = new URL("/api/v1/query", prometheusUrl);
  url.searchParams.set("query", query);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return [];
  const json = await res.json() as { status: string; data: { resultType: string; result: PromVectorResult[] } };
  if (json.status !== "success" || json.data.resultType !== "vector") return [];
  return json.data.result;
}

const LiveMetricsNodeSchema = z.object({
  nodeId: z.string(),
  utilizationAvg: z.number(),
  energyWh: z.number(),
});

const LiveMetricsOutput = z.object({
  available: z.boolean(),
  nodes: z.array(LiveMetricsNodeSchema),
});

const fleetLiveMetrics = rootOs
  .use(withInstanceAdmin)
  .route({
    path: "/live-metrics", method: "GET", tags,
    summary: "Get Fleet Live Metrics",
    description: "Queries Prometheus for real-time GPU utilization and energy. Returns available=false when PROMETHEUS_URL is not configured or Prometheus is unreachable.",
  })
  .input(z.object({}).optional())
  .output(LiveMetricsOutput)
  .handler(async () => {
    const prometheusUrl = serverEnv.PROMETHEUS_URL;
    if (!prometheusUrl) return { available: false, nodes: [] };

    try {
      const [utilResults, energyResults] = await Promise.all([
        queryPrometheusInstant(prometheusUrl, "daemon_gpu_utilization_avg"),
        queryPrometheusInstant(prometheusUrl, "daemon_gpu_energy_wh_total"),
      ]);

      const nodeMap = new Map<string, { utilizationAvg: number; energyWh: number }>();

      for (const r of utilResults) {
        const nodeId = r.metric["node_id"];
        if (nodeId) nodeMap.set(nodeId, { utilizationAvg: parseFloat(r.value[1]) || 0, energyWh: 0 });
      }
      for (const r of energyResults) {
        const nodeId = r.metric["node_id"];
        if (!nodeId) continue;
        const existing = nodeMap.get(nodeId);
        const energyWh = parseFloat(r.value[1]) || 0;
        if (existing) existing.energyWh = energyWh;
        else nodeMap.set(nodeId, { utilizationAvg: 0, energyWh });
      }

      return {
        available: true,
        nodes: [...nodeMap.entries()].map(([nodeId, m]) => ({ nodeId, ...m })),
      };
    } catch {
      return { available: false, nodes: [] };
    }
  });

export const fleetRouter = rootOs.prefix("/fleet").router({
  overview: fleetOverview,
  history: fleetHistory,
  liveMetrics: fleetLiveMetrics,
});
