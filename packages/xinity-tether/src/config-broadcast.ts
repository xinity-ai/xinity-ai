import type { PinoLike } from "common-env";
import { DAEMON_DYNAMIC_KEYS } from "./daemon-config-keys";

const COALESCE_WINDOW_MS = 200;

/** Every daemon gets every daemon setting. Which of them a node uses is the node's own business. */
function daemonKeysOf(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    DAEMON_DYNAMIC_KEYS.filter((key) => key in values).map((key) => [key, values[key]!]),
  );
}

export type ConfigBroadcastDeps = {
  channel: string;
  read: () => Promise<Record<string, string>>;
  subscribe: (
    channel: string,
    onNotify: (payload: string) => void,
    onSubscribed?: () => void,
  ) => Promise<() => Promise<void>>;
  pushToAll: (values: Record<string, string>) => void;
  pushTo: (nodeId: string, values: Record<string, string>) => void;
  log: PinoLike;
};

export function createConfigBroadcast(deps: ConfigBroadcastDeps) {
  let unlisten: (() => Promise<void>) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: Record<string, string> = {};

  function queueRefresh(): void {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, COALESCE_WINDOW_MS);
  }

  async function refresh(): Promise<void> {
    try {
      latest = daemonKeysOf(await deps.read());
    } catch (err) {
      deps.log.error({ err }, "Failed to read dynamic configuration for daemons");
      return;
    }
    deps.pushToAll(latest);
  }

  return {
    async start(): Promise<void> {
      unlisten = await deps.subscribe(deps.channel, queueRefresh, queueRefresh);
    },

    sendCurrent(nodeId: string): void {
      deps.pushTo(nodeId, latest);
    },

    async stop(): Promise<void> {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        await unlisten?.();
      } catch (err) {
        deps.log.warn({ err }, "Failed to unlisten from dynamic configuration");
      }
      unlisten = null;
    },
  };
}
