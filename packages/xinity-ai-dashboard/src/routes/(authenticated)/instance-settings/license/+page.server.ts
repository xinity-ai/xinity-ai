import type { PageServerLoad } from "./$types";
import { getLicenseSummary } from "$lib/server/license";
import { getDeploymentId } from "$lib/server/deployment-id";

export const load: PageServerLoad = async () => {
  return {
    license: getLicenseSummary(),
    instanceId: getDeploymentId(),
  };
};
