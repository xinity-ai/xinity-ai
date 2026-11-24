import type { PageServerLoad } from "./$types";
import { router } from "$lib/server/orpc/router";
import { call } from "@orpc/server";
import type { DeploymentOutput } from "$lib/orpc/dtos/model.dto";
import type { ApplicationDto } from "$lib/orpc/dtos/application.dto";
import { isRedirect, isHttpError } from "@sveltejs/kit";

export const load: PageServerLoad = async ({ parent, locals }) => {
  const { session } = await parent();
  const activeOrgId = session.activeOrganizationId;

  if (!activeOrgId) {
    return {
      deployments: Promise.resolve([] as DeploymentOutput[]),
      applications: [] as ApplicationDto[],
    };
  }

  // Stream deployments - page renders immediately with skeletons while this resolves
  const deployments = call(router.deployments.list, { withStatus: true }, { context: locals });
  const applications = await call(router.application.list, {}, { context: locals })
    .catch((err): ApplicationDto[] => {
      if (isRedirect(err) || isHttpError(err)) throw err;
      return [];
    });

  return { deployments, applications };
};

export type { DeploymentOutput as DeploymentDefinition };
