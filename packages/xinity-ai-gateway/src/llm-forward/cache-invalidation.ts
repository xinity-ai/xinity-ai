import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "cache-invalidation" });

/** Tables the routing cache is derived from. */
const SOURCE_CHANNELS = ["ai_node", "model_installation", "model_installation_state"] as const;
const DEPLOYMENT_CHANNEL = "model_deployment";

type CacheInvalidationDeps = {
  subscribe: (
    channel: string,
    onNotify: (payload: string) => void,
    onSubscribed?: () => void,
  ) => Promise<() => Promise<void>>;
  invalidateModelSources: () => void;
  invalidateDeployments: () => Promise<void>;
};

export function createCacheInvalidation(deps: CacheInvalidationDeps) {
  const unlisteners: Array<() => Promise<void>> = [];

  // Also used as the re-subscribe hook: notifications published while the connection
  // was down are gone, so whatever that channel feeds has to be dropped either way.
  const onSourceChange = () => deps.invalidateModelSources();
  const onDeploymentChange = () => void deps.invalidateDeployments();

  return {
    async start(): Promise<void> {
      for (const channel of SOURCE_CHANNELS) {
        unlisteners.push(await deps.subscribe(channel, onSourceChange, onSourceChange));
      }
      unlisteners.push(await deps.subscribe(DEPLOYMENT_CHANNEL, onDeploymentChange, onDeploymentChange));
      log.info({ channels: [...SOURCE_CHANNELS, DEPLOYMENT_CHANNEL] }, "Listening for cache invalidation");
    },

    async stop(): Promise<void> {
      const pending = unlisteners.splice(0);
      for (const unlisten of pending) {
        try {
          await unlisten();
        } catch (err) {
          log.warn({ err }, "Failed to unlisten");
        }
      }
    },
  };
}
