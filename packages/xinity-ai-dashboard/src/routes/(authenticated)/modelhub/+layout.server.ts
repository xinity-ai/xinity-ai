import type { LayoutServerLoad } from "./$types";
import { buildClusterOverview, type ClusterOverview } from "$lib/server/orpc/procedures/cluster.procedure";

const emptyCluster: ClusterOverview = {
  maxNodeFreeCapacity: 0,
  availableDrivers: [],
  nodeFreeCapacities: [],
  nodeCapabilities: [],
  modelCompatibility: {},
};

export const load: LayoutServerLoad = async ({ parent, depends }) => {
  depends("resource:cluster");
  const { session } = await parent();
  if (!session.activeOrganizationId) {
    return { cluster: emptyCluster };
  }
  return { cluster: await buildClusterOverview() };
};
