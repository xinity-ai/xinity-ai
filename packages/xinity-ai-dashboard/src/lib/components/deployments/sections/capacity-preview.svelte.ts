import { browserLogger } from "$lib/browserLogging";
import { orpc } from "$lib/orpc/orpc-client";
import type { CapacityCheckResult } from "$lib/server/orpc/procedures/deployment.procedure";
import type { DeploymentOutput } from "$lib/orpc/dtos/model.dto";
import { handleVariant, type VariantHandlers } from "$lib/util";

export type CapacityRequest = Parameters<typeof orpc.deployments.checkCapacity>[0];

const PREVIEW_DELAY_MS = 300;

/**
 * `result` is undefined until the first answer or when there is nothing to ask, and null when the check failed.
 * `refused` is whether saving it would be refused, which only applies while `enforced` holds.
 */
export function capacityPreview(request: () => CapacityRequest | null, enforced: () => boolean = () => true) {
  let result = $state<CapacityCheckResult | null | undefined>(undefined);
  const refused = $derived(enforced() && result?.deployable === false);

  $effect(() => {
    const asked = $state.snapshot(request());
    if (!asked) {
      result = undefined;
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      const [error, checked] = await orpc.deployments.checkCapacity(asked, { signal: abort.signal });
      if (abort.signal.aborted) {
        return;
      }
      if (error) {
        browserLogger.error({ error }, "Capacity check failed");
        result = null;
        return;
      }
      result = checked;
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  });

  return {
    get result() {
      return result;
    },
    get refused() {
      return refused;
    },
  };
}

// `deploymentId` keeps the deployment's own running replicas in place. A draft being created has none, and no id yet.
const CAPACITY_REQUESTS: VariantHandlers<DeploymentOutput, CapacityRequest | null, [string | undefined]> = {
  legacy: ({ legacy }, deploymentId) => ({
    type: "legacy",
    deploymentId,
    legacy: {
      specifier: legacy.specifier,
      earlySpecifier: legacy.earlySpecifier,
      replicas: legacy.replicas,
      progress: Math.round(legacy.progress),
      kvCacheSize: legacy.kvCacheSize || null,
      earlyKvCacheSize: legacy.earlyKvCacheSize || null,
      preferredDriver: legacy.preferredDriver,
      settings: legacy.settings,
    },
  }),
  managed: ({ managed }, deploymentId) => ({ type: "managed", deploymentId, managed }),
  canary: ({ canary: { replicas, progress, from, to } }, deploymentId) => ({ type: "canary", deploymentId, canary: { replicas, progress, from, to } }),
};

export const capacityRequestOf = (deployment: DeploymentOutput, deploymentId: string | undefined) =>
  handleVariant(CAPACITY_REQUESTS, deployment, deploymentId);
