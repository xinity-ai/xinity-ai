import { rootOs, withOrganization, requirePermission } from "../root";
import { sql, aiNodeT, modelInstallationT } from "common-db";
import { getDB } from "$lib/server/db";
import z from "zod";
import type { NodeCapability } from "xinity-infoserver";

const tags = ["Cluster"];

const GpuInfoSchema = z.object({
  vendor: z.string(),
  name: z.string(),
  vramMb: z.number(),
});

const NodeCapabilitySchema = z.object({
  free: z.number(),
  driverVersions: z.record(z.string(), z.string()),
  gpus: z.array(GpuInfoSchema),
});

const ClusterCapacityOutput = z.object({
  maxNodeFreeCapacity: z.number(),
  availableDrivers: z.array(z.string()),
  nodeFreeCapacities: z.array(z.number()),
  nodeCapabilities: z.array(NodeCapabilitySchema),
});
export type ClusterCapacity = z.infer<typeof ClusterCapacityOutput>;

/**
 * Builds a snapshot of current cluster capacity and per-node capabilities.
 * Exported as a plain function so both the oRPC endpoint and +page.server.ts
 * can call it directly without HTTP overhead.
 */
export async function buildClusterCapacity(): Promise<ClusterCapacity> {
  const [nodes, installations] = await Promise.all([
    getDB().select({
      id: aiNodeT.id,
      estCapacity: aiNodeT.estCapacity,
      driverVersions: aiNodeT.driverVersions,
      gpus: aiNodeT.gpus,
    }).from(aiNodeT)
      .where(sql`${aiNodeT.available} AND ${aiNodeT.deletedAt} IS NULL`),
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

const clusterCapacity = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route({
    path: "/capacity", method: "GET", tags,
    summary: "Get Cluster Capacity",
    description: "Returns free VRAM capacity and per-node capabilities across all available nodes",
  })
  .output(ClusterCapacityOutput)
  .handler(buildClusterCapacity);

export const clusterRouter = rootOs.prefix("/cluster").router({
  capacity: clusterCapacity,
});
