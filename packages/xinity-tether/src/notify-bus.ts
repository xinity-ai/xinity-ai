import type { DesiredState } from "common-env";
import { rootLogger } from "./logger";

const log = rootLogger.child({ name: "notify-bus" });

/** Must match the channel the model_installation trigger publishes to. */
export const CHANNEL = "model_installation";
const COALESCE_WINDOW_MS = 200;

type NotifyBusDeps = {
  subscribe: (
    channel: string,
    onNotify: (payload: string) => void,
    onSubscribed?: () => void,
  ) => Promise<() => Promise<void>>;
  buildDesiredState: (nodeId: string) => Promise<DesiredState>;
  pushDesiredState: (nodeId: string, state: DesiredState) => boolean;
  isConnected: (nodeId: string) => boolean;
  getConnectedNodeIds: () => string[];
};

export function createNotifyBus(deps: NotifyBusDeps) {
  const pending = new Set<string>();
  let flushTimer: Timer | null = null;
  let unlisten: (() => Promise<void>) | null = null;

  function queue(nodeId: string): void {
    pending.add(nodeId);
    if (flushTimer === null) {
      flushTimer = setTimeout(() => void flush(), COALESCE_WINDOW_MS);
    }
  }

  async function flush(): Promise<void> {
    flushTimer = null;
    const nodeIds = [...pending];
    pending.clear();

    for (const nodeId of nodeIds) {
      if (!deps.isConnected(nodeId)) {
        continue;
      }
      try {
        deps.pushDesiredState(nodeId, await deps.buildDesiredState(nodeId));
      } catch (err) {
        log.error({ err, nodeId }, "Failed to push desired state after notification");
      }
    }
  }

  return {
    async start(): Promise<void> {
      // Notifications sent while the listen connection was down are lost, so every
      // live daemon is re-synced whenever the subscription is established again.
      unlisten = await deps.subscribe(CHANNEL, queue, () => {
        for (const nodeId of deps.getConnectedNodeIds()) {
          queue(nodeId);
        }
      });
      log.info({ channel: CHANNEL }, "Listening for installation changes");
    },

    async stop(): Promise<void> {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pending.clear();

      try {
        await unlisten?.();
      } catch (err) {
        log.warn({ err }, "Failed to unlisten");
      }
      unlisten = null;
    },
  };
}
