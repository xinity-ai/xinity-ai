import type { PageServerLoad } from "./$types";
import { router } from "$lib/server/orpc/router";
import { call } from "@orpc/server";
import { buildClusterCapacity, type ClusterCapacity } from "$lib/server/orpc/procedures/cluster.procedure";
import type { DeploymentWithStatus } from "$lib/server/orpc/procedures/deployment.procedure";

const emptyCapacity: ClusterCapacity = {
  maxNodeFreeCapacity: 0,
  availableDrivers: [],
  nodeFreeCapacities: [],
  nodeCapabilities: [],
};

export const load: PageServerLoad = async ({ parent, request }) => {
  const { session } = await parent();
  const activeOrgId = session.activeOrganizationId;

  if (!activeOrgId) {
    return { deployments: Promise.resolve([] as DeploymentWithStatus[]), ...emptyCapacity };
  }

  // Stream deployments - page renders immediately with skeletons while this resolves
  const deployments = call(router.deployment.list, { withStatus: true }, { context: { request } });
  const capacity = await buildClusterCapacity();

  return { deployments, ...capacity };
};

export type { DeploymentWithStatus as DeploymentDefinition };
