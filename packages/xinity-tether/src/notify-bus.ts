import { subscribe, end as endDB } from "./db";
import { rootLogger } from "./logger";
import { buildDesiredState } from "./desired-state";
import { pushDesiredState, isConnected, getConnectedNodeIds } from "./connections";

const log = rootLogger.child({ name: "notify-bus" });

/** Must match the channel the model_installation trigger publishes to. */
const CHANNEL = "model_installation";
const COALESCE_WINDOW_MS = 200;

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
    if (!isConnected(nodeId)) {
      continue;
    }
    try {
      pushDesiredState(nodeId, await buildDesiredState(nodeId));
    } catch (err) {
      log.error({ err, nodeId }, "Failed to push desired state after notification");
    }
  }
}

export async function start(): Promise<void> {
  // Notifications sent while the listen connection was down are lost, so every live
  // daemon is re-synced whenever the subscription is established again.
  unlisten = await subscribe(CHANNEL, queue, () => {
    for (const nodeId of getConnectedNodeIds()) {
      queue(nodeId);
    }
  });
  log.info({ channel: CHANNEL }, "Listening for installation changes");
}

export async function stop(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  try {
    await unlisten?.();
  } catch (err) {
    log.warn({ err }, "Failed to unlisten");
  }
  unlisten = null;

  await endDB();
}
