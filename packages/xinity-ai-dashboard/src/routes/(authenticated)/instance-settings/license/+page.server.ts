import type { PageServerLoad } from "./$types";
import { getLicenseSummary } from "$lib/server/license";
import { getDeploymentId, loadDeploymentId } from "$lib/server/deployment-id";
import { rootLogger } from "$lib/server/logging";
import { configStore } from "$lib/server/config";
import { listOverrides } from "../configuration/dynamic-config";

const log = rootLogger.child({ name: "instance-settings.license" });

const LICENSE_KEY = "LICENSE_KEY";

async function licenseKeyOrigin() {
  if (!configStore.delegatedKeys.includes(LICENSE_KEY)) {
    return { delegated: false, managedHere: false, digest: undefined };
  }

  try {
    const override = (await listOverrides()).find((entry) => entry.key === LICENSE_KEY);
    return { delegated: true, managedHere: override !== undefined, digest: override?.digest };
  } catch (err) {
    log.error({ err }, "Failed to read whether the license key is set from the dashboard");
    return { delegated: true, managedHere: false, digest: undefined };
  }
}

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
    licenseKey: await licenseKeyOrigin(),
  };
};
