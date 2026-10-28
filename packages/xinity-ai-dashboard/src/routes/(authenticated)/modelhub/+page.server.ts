import type { PageServerLoad } from "./$types";
import { router } from "$lib/server/orpc/router";
import { call } from "@orpc/server";
import { buildClusterOverview, type ClusterOverview } from "$lib/server/orpc/procedures/cluster.procedure";
import type { DeploymentOutput } from "$lib/orpc/dtos/model.dto";
import type { ApplicationDto } from "$lib/orpc/dtos/application.dto";
import { isRedirect, isHttpError } from "@sveltejs/kit";

const emptyCapacity: ClusterOverview = {
  maxNodeFreeCapacity: 0,
  availableDrivers: [],
  nodeFreeCapacities: [],
  nodeCapabilities: [],
  modelCompatibility: {},
};

export const load: PageServerLoad = async ({ parent, locals }) => {
  const { session } = await parent();
  const activeOrgId = session.activeOrganizationId;

  if (!activeOrgId) {
    return {
      deployments: Promise.resolve([] as DeploymentOutput[]),
      applications: [] as ApplicationDto[],
      ...emptyCapacity,
    };
  }

  // Stream deployments - page renders immediately with skeletons while this resolves
  const deployments = call(router.deployments.list, { withStatus: true }, { context: locals });
  const [capacity, applications] = await Promise.all([
    buildClusterOverview(),
    call(router.application.list, {}, { context: locals })
      .catch((err): ApplicationDto[] => {
        if (isRedirect(err) || isHttpError(err)) throw err;
        return [];
      }),
  ]);

  return { deployments, applications, ...capacity };
};

// The modelhub renders the types it has views for, see `hasView`.
export type DeploymentDefinition = Extract<DeploymentOutput, { type: "legacy" }>;
