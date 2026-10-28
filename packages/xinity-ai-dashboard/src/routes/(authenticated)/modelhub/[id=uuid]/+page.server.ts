import { error, isHttpError, isRedirect } from "@sveltejs/kit";
import { call, ORPCError } from "@orpc/server";
import type { PageServerLoad } from "./$types";
import { router } from "$lib/server/orpc/router";
import type { ApplicationDto } from "$lib/orpc/dtos/application.dto";

export const load: PageServerLoad = async ({ params, parent, locals }) => {
  const { session } = await parent();
  if (!session.activeOrganizationId) {
    return { deployment: null };
  }

  try {
    const [deployment, applications] = await Promise.all([
      call(router.deployments.get, { id: params.id, withStatus: true }, { context: locals }),
      call(router.application.list, {}, { context: locals }).catch((err): ApplicationDto[] => {
        if (isRedirect(err) || isHttpError(err)) throw err;
        return [];
      }),
    ]);
    return { deployment, applications };
  } catch (err) {
    if (err instanceof ORPCError && err.code === "NOT_FOUND") {
      error(404, "Deployment not found");
    }
    throw err;
  }
};
