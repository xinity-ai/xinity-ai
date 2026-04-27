import type { PageServerLoad } from "./$types";
import { router } from "$lib/server/orpc/router";
import { call } from "@orpc/server";
import { buildClusterCapacity, type ClusterCapacity } from "$lib/server/orpc/procedures/cluster.procedure";
import type { DeploymentWithStatus } from "$lib/server/orpc/procedures/deployment.procedure";
import type { ApplicationDto } from "$lib/orpc/dtos/application.dto";
import { isRedirect, isHttpError } from "@sveltejs/kit";

const emptyCapacity: ClusterCapacity = {
  maxNodeFreeCapacity: 0,
  availableDrivers: [],
  nodeFreeCapacities: [],
  nodeCapabilities: [],
};

export const load: PageServerLoad = async ({ parent, locals, request }) => {
  const { session } = await parent();
  const activeOrgId = session.activeOrganizationId;

  if (!activeOrgId) {
    return {
      deployments: Promise.resolve([] as DeploymentWithStatus[]),
      applications: [] as ApplicationDto[],
      ...emptyCapacity,
    };
  }

  // Stream deployments - page renders immediately with skeletons while this resolves
  const deployments = call(router.deployment.list, { withStatus: true }, { context: { request } });
  const capacity = await buildClusterCapacity();
  const applications = await call(router.application.list, {}, { context: locals })
    .then((r) => r as ApplicationDto[])
    .catch((err) => {
      if (isRedirect(err) || isHttpError(err)) throw err;
      return [] as ApplicationDto[];
    });

  return { deployments, applications, ...capacity };
};

export type { DeploymentWithStatus as DeploymentDefinition };
