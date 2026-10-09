import { rootOs, withOrganization, requirePermission } from "../root";
import { sql, aiNodeT, modelInstallationT } from "common-db";
import { getDB } from "$lib/server/db";
import { nodeIsLive } from "$lib/server/lib/deployments/node-liveness";
import { rootLogger } from "$lib/server/logging";
import { catalogClient } from "$lib/server/lib/models/model-catalog";
import z from "zod";
import { blockedVersionNotes, explainClusterIncompatibility, IncompatibilityReasonEnum, type NodeCapability } from "common-env/model-catalog";

const log = rootLogger.child({ name: "cluster" });

const tags = ["Cluster"];

const GpuInfoSchema = z.object({
  vendor: z.string(),
  name: z.string(),
  vramMb: z.number(),
});

const NodeCapabilitySchema = z.object({
  free: z.number(),
  driverVersions: z.record(z.string(), z.string()),
  driverFeatures: z.record(z.string(), z.array(z.string())).optional(),
  gpus: z.array(GpuInfoSchema),
});

const ClusterCapacityOutput = z.object({
  maxNodeFreeCapacity: z.number(),
  availableDrivers: z.array(z.string()),
  nodeFreeCapacities: z.array(z.number()),
  nodeCapabilities: z.array(NodeCapabilitySchema),
});
export type ClusterCapacity = z.infer<typeof ClusterCapacityOutput>;

const ClusterOverviewOutput = ClusterCapacityOutput.extend({
  modelCompatibility: z.record(z.string(), z.object({
    incompatibility: IncompatibilityReasonEnum.nullable(),
    blockedReleaseNote: z.string().optional(),
  })).describe("Per catalog model, keyed by public specifier. Empty when no node is live or the catalog is unavailable"),
});
export type ClusterOverview = z.infer<typeof ClusterOverviewOutput>;
export type ModelCompatibility = ClusterOverview["modelCompatibility"];

async function buildModelCompatibility(nodes: NodeCapability[]): Promise<ModelCompatibility> {
  if (nodes.length === 0 || !catalogClient) {
    return {};
  }
  let models;
  try {
    models = await catalogClient.getAll();
  } catch (err) {
    log.warn({ err }, "Model catalog unavailable, skipping model compatibility");
    return {};
  }
  return Object.fromEntries(models.map(model => {
    const notes = blockedVersionNotes(nodes, model);
    return [model.publicSpecifier, {
      incompatibility: explainClusterIncompatibility(nodes, model),
      blockedReleaseNote: notes.length > 0 ? notes.join(" ") : undefined,
    }];
  }));
}

/** Builds a snapshot of current cluster capacity and per-node capabilities. */
export async function buildClusterCapacity(): Promise<ClusterCapacity> {
  const [nodes, installations] = await Promise.all([
    getDB().select({
      id: aiNodeT.id,
      estCapacity: aiNodeT.estCapacity,
      driverVersions: aiNodeT.driverVersions,
      driverFeatures: aiNodeT.driverFeatures,
      gpus: aiNodeT.gpus,
    }).from(aiNodeT).where(nodeIsLive),
    getDB().select().from(modelInstallationT)
      .where(sql`${modelInstallationT.deletedAt} IS NULL`),
  ]);

  const nodeUsed = new Map<string, number>();
  for (const inst of installations) {
    nodeUsed.set(inst.nodeId, (nodeUsed.get(inst.nodeId) ?? 0) + inst.estCapacity);
  }

  const nodeCapabilities: NodeCapability[] = nodes.map(n => ({
    free: n.estCapacity - (nodeUsed.get(n.id) ?? 0),
    driverVersions: n.driverVersions,
    driverFeatures: n.driverFeatures ?? {},
    gpus: n.gpus,
  }));

  const nodesWithFreeCapacity = nodeCapabilities.filter(n => n.free > 0);
  const maxNodeFreeCapacity = Math.max(0, ...nodeCapabilities.map(n => n.free));
  const availableDrivers = [...new Set(
    nodesWithFreeCapacity.flatMap(n => Object.keys(n.driverVersions)),
  )];
  const nodeFreeCapacities = nodesWithFreeCapacity.map(n => n.free).sort((a, b) => b - a);

  return { maxNodeFreeCapacity, availableDrivers, nodeFreeCapacities, nodeCapabilities };
}

export async function buildClusterOverview(): Promise<ClusterOverview> {
  const capacity = await buildClusterCapacity();
  return { ...capacity, modelCompatibility: await buildModelCompatibility(capacity.nodeCapabilities) };
}

const clusterCapacity = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route({
    path: "/capacity", method: "GET", tags,
    summary: "Get Cluster Capacity",
    description: "Returns free VRAM capacity, per-node capabilities and per-model deployability across all available nodes",
  })
  .output(ClusterOverviewOutput)
  .handler(buildClusterOverview);

export const clusterRouter = rootOs.prefix("/cluster").router({
  capacity: clusterCapacity,
});
