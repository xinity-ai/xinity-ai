import { rootOs, withOrganization, requirePermission } from "../root";
import { sql, isNull, aiNodeT, modelInstallationT } from "common-db";
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
  drivers: z.array(z.string()),
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
  const nodes = await getDB().select().from(aiNodeT)
    .where(sql`${aiNodeT.available} AND ${aiNodeT.deletedAt} IS NULL`);
  const installations = await getDB().select().from(modelInstallationT)
    .where(isNull(modelInstallationT.deletedAt));

  const nodeUsed = new Map<string, number>();
  for (const inst of installations) {
    nodeUsed.set(inst.nodeId, (nodeUsed.get(inst.nodeId) ?? 0) + inst.estCapacity);
  }

  const nodeCapabilities: NodeCapability[] = nodes.map(n => ({
    free: n.estCapacity - (nodeUsed.get(n.id) ?? 0),
    drivers: n.drivers,
    driverVersions: (n.driverVersions ?? {}) as Record<string, string>,
    gpus: (n.gpus ?? []) as { vendor: string; name: string; vramMb: number }[],
  }));

  const maxNodeFreeCapacity = Math.max(0, ...nodeCapabilities.map(n => n.free));
  const availableDrivers = [...new Set(
    nodeCapabilities.filter(n => n.free > 0).flatMap(n => n.drivers),
  )];
  const nodeFreeCapacities = nodeCapabilities
    .map(n => n.free).filter(c => c > 0).sort((a, b) => b - a);

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
