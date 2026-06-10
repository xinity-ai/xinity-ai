import { rootOs, withOrganization, requirePermission } from "../root";
import {
  aiNodeT,
  modelInstallationT,
  modelInstallationStateT,
  nodeMetricT,
  usageEventT,
  sql,
  and,
  desc,
  eq,
  gte,
  isNull,
  isNotNull,
  count,
} from "common-db";
import { getDB } from "$lib/server/db";
import {
  HEARTBEAT_FRESH_MS,
  isNodeOnline,
  mergeHistorySeries,
  pickBucketSeconds,
} from "$lib/server/fleet/fleet";
import z from "zod";

const tags = ["Fleet"];

// Like /cluster/capacity, fleet data is instance-wide infrastructure state, not
// org-scoped: machines serve all orgs, and the page shows hardware health plus
// aggregate counters (no request content, no per-org breakdown). The guard
// mirrors cluster.procedure: any role with modelDeployment read access.

const RangeInputSchema = z.object({
  rangeHours: z.coerce.number().int().min(1).max(90 * 24).default(24),
});

const GpuInfoSchema = z.object({
  vendor: z.string(),
  name: z.string(),
  vramMb: z.number(),
});

const NodeMetricsSchema = z.object({
  /** Epoch ms of the metric bucket start; lets the UI judge freshness. */
  bucketStart: z.number(),
  gpuUtilizationAvg: z.number(),
  gpuUtilizationMax: z.number(),
  memoryUsedMb: z.number(),
  powerWattsAvg: z.number().nullable(),
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
  /** Epoch ms of the last daemon heartbeat. Null for nodes that predate telemetry. */
  lastSeenAt: z.number().nullable(),
  gpuCount: z.number(),
  gpus: z.array(GpuInfoSchema),
  estCapacity: z.number(),
  totalEnergyWh: z.number(),
  /** Energy consumed within the requested range (approximate). */
  energyWh: z.number(),
  /** Latest reported metrics; null while a node hasn't reported yet ("warming up"). */
  metrics: NodeMetricsSchema.nullable(),
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
  energyWh: z.number(),
  /** Current fleet-wide utilization averaged over online nodes with fresh metrics. */
  utilizationAvg: z.number().nullable(),
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
  utilizationAvg: z.number().nullable(),
  energyWh: z.number(),
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
  const now = Date.now();
  const since = new Date(now - rangeHours * 60 * 60 * 1000);
  const db = getDB();

  const [nodes, installations, usageRows, latestMetrics, rangeMetrics] = await Promise.all([
    db.select({
      id: aiNodeT.id,
      host: aiNodeT.host,
      machineName: aiNodeT.machineName,
      available: aiNodeT.available,
      lastSeenAt: aiNodeT.lastSeenAt,
      gpuCount: aiNodeT.gpuCount,
      gpus: aiNodeT.gpus,
      estCapacity: aiNodeT.estCapacity,
      totalEnergyWh: aiNodeT.totalEnergyWh,
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
      .where(gte(usageEventT.createdAt, since))
      .groupBy(usageEventT.nodeId),

    db.selectDistinctOn([nodeMetricT.nodeId], {
      nodeId: nodeMetricT.nodeId,
      bucketStart: nodeMetricT.bucketStart,
      gpuUtilizationAvg: nodeMetricT.gpuUtilizationAvg,
      gpuUtilizationMax: nodeMetricT.gpuUtilizationMax,
      memoryUsedMb: nodeMetricT.memoryUsedMb,
      powerWattsAvg: nodeMetricT.powerWattsAvg,
    }).from(nodeMetricT)
      .orderBy(nodeMetricT.nodeId, desc(nodeMetricT.bucketStart)),

    db.select({
      nodeId: nodeMetricT.nodeId,
      energyWh: sumNumber(nodeMetricT.energyWh),
    }).from(nodeMetricT)
      .where(gte(nodeMetricT.bucketStart, since))
      .groupBy(nodeMetricT.nodeId),
  ]);

  const usageByNode = new Map(usageRows.map((r) => [r.nodeId, r]));
  const metricsByNode = new Map(latestMetrics.map((r) => [r.nodeId, r]));
  const energyByNode = new Map(rangeMetrics.map((r) => [r.nodeId, r.energyWh]));
  const modelsByNode = new Map<string, typeof installations>();
  for (const inst of installations) {
    const list = modelsByNode.get(inst.nodeId) ?? [];
    list.push(inst);
    modelsByNode.set(inst.nodeId, list);
  }

  const emptyUsage = { requests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0 };

  const fleetNodes: FleetNode[] = nodes.map((node) => {
    const metric = metricsByNode.get(node.id);
    const usage = usageByNode.get(node.id);
    return {
      id: node.id,
      host: node.host,
      machineName: node.machineName,
      online: isNodeOnline(node.available, node.lastSeenAt, now),
      lastSeenAt: node.lastSeenAt?.getTime() ?? null,
      gpuCount: node.gpuCount,
      gpus: node.gpus,
      estCapacity: node.estCapacity,
      totalEnergyWh: node.totalEnergyWh,
      energyWh: energyByNode.get(node.id) ?? 0,
      metrics: metric
        ? {
            bucketStart: metric.bucketStart.getTime(),
            gpuUtilizationAvg: metric.gpuUtilizationAvg,
            gpuUtilizationMax: metric.gpuUtilizationMax,
            memoryUsedMb: metric.memoryUsedMb,
            powerWattsAvg: metric.powerWattsAvg,
          }
        : null,
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

  // Totals include events not attributable to a (still existing) node, so the
  // fleet-wide numbers stay consistent with the org usage dashboard.
  const totalUsage = usageRows.reduce(
    (acc, r) => ({
      requests: acc.requests + r.requests,
      failedRequests: acc.failedRequests + r.failedRequests,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
    }),
    emptyUsage,
  );

  const freshUtilizations = fleetNodes
    .filter((n) => n.online && n.metrics && now - n.metrics.bucketStart <= HEARTBEAT_FRESH_MS)
    .map((n) => n.metrics!.gpuUtilizationAvg);

  return {
    rangeHours,
    nodes: fleetNodes,
    totals: {
      machinesOnline: fleetNodes.filter((n) => n.online).length,
      machinesTotal: fleetNodes.length,
      gpuCount: fleetNodes.reduce((acc, n) => acc + n.gpuCount, 0),
      ...totalUsage,
      energyWh: rangeMetrics.reduce((acc, r) => acc + r.energyWh, 0),
      utilizationAvg: freshUtilizations.length > 0
        ? freshUtilizations.reduce((a, b) => a + b, 0) / freshUtilizations.length
        : null,
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
  const metricBucket = sql`floor(extract(epoch from ${nodeMetricT.bucketStart}) / ${width}) * ${width}`;
  const usageBucket = sql`floor(extract(epoch from ${usageEventT.createdAt}) / ${width}) * ${width}`;

  const [metricRows, usageRows] = await Promise.all([
    db.select({
      nodeId: nodeMetricT.nodeId,
      t: sql<number>`${metricBucket}`.mapWith(Number),
      utilizationAvg: sql<number>`avg(${nodeMetricT.gpuUtilizationAvg})`.mapWith(Number),
      energyWh: sumNumber(nodeMetricT.energyWh),
    }).from(nodeMetricT)
      .where(gte(nodeMetricT.bucketStart, since))
      .groupBy(nodeMetricT.nodeId, metricBucket),

    db.select({
      nodeId: sql<string>`${usageEventT.nodeId}`,
      t: sql<number>`${usageBucket}`.mapWith(Number),
      tokens: sql<number>`coalesce(sum(${usageEventT.inputTokens} + ${usageEventT.outputTokens}), 0)`.mapWith(Number),
      requests: count(),
    }).from(usageEventT)
      .where(and(gte(usageEventT.createdAt, since), isNotNull(usageEventT.nodeId)))
      .groupBy(usageEventT.nodeId, usageBucket),
  ]);

  return {
    rangeHours,
    bucketSeconds,
    series: mergeHistorySeries(metricRows, usageRows),
  };
}

const fleetOverview = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route({
    path: "/overview", method: "GET", tags,
    summary: "Get Fleet Overview",
    description: "Returns all compute nodes with hardware inventory, liveness, installed models, and approximate utilization, energy, and request statistics",
  })
  .input(RangeInputSchema.optional())
  .output(FleetOverviewOutput)
  .handler(({ input }) => buildFleetOverview(input?.rangeHours ?? 24));

const fleetHistory = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route({
    path: "/history", method: "GET", tags,
    summary: "Get Fleet History",
    description: "Returns bucketed per-node time series of utilization, energy, and token throughput for charts",
  })
  .input(RangeInputSchema.optional())
  .output(FleetHistoryOutput)
  .handler(({ input }) => buildFleetHistory(input?.rangeHours ?? 24));

export const fleetRouter = rootOs.prefix("/fleet").router({
  overview: fleetOverview,
  history: fleetHistory,
});
