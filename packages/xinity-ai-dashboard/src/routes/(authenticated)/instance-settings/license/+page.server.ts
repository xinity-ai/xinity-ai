import type { PageServerLoad } from "./$types";
import { getLicenseSummary } from "$lib/server/license";
import { getDeploymentId, loadDeploymentId } from "$lib/server/deployment-id";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "instance-settings.license" });

export const load: PageServerLoad = async () => {
  // If the startup warmup failed (transient DB error), recover on demand so the
  // page can show the instance ID instead of a permanent "not initialised" state.
  let instanceId = getDeploymentId();
  if (!instanceId) {
    try {
      instanceId = await loadDeploymentId();
    } catch (err) {
      log.error({ err }, "Failed to load deployment instance ID on demand");
      instanceId = null;
    }
  }

  return {
    license: getLicenseSummary(),
    instanceId,
  };
};
