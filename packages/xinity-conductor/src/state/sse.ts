import { rootLogger } from "../logger";
import { buildDesiredState } from "./query";
import { subscribe as subscribeToNodeChanges } from "./node-change-bus";

const log = rootLogger.child({ name: "sse" });
const KEEPALIVE_MS = 30_000;
const encoder = new TextEncoder();

type Sender = (event: string, data: unknown) => void;

/** Open an SSE response that streams desired-state messages for a specific runner node. */
export function openStateStream(nodeId: string, signal: AbortSignal): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const send: Sender = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const sendKeepalive = () => {
        controller.enqueue(encoder.encode(`: keepalive\n\n`));
      };

      const initialOk = await sendInitialState(nodeId, send);
      if (!initialOk) {
        controller.close();
        return;
      }

      const stopKeepalive = startKeepalive(sendKeepalive);
      const unsubscribe = subscribeToNodeChanges(nodeId, () => {
        if (signal.aborted) {
          return;
        }
        void pushFreshState(nodeId, send);
      });

      await waitForAbort(signal);
      stopKeepalive();
      unsubscribe();

      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
    },
  });
}

async function sendInitialState(nodeId: string, send: Sender): Promise<boolean> {
  try {
    send("state", await buildDesiredState(nodeId));
    return true;
  } catch (err) {
    log.error({ err, nodeId }, "Failed to send initial desired state");
    return false;
  }
}

async function pushFreshState(nodeId: string, send: Sender): Promise<void> {
  try {
    send("state", await buildDesiredState(nodeId));
  } catch (err) {
    log.warn({ err, nodeId }, "Failed to push state on notify");
  }
}

function startKeepalive(sendKeepalive: () => void): () => void {
  const timer = setInterval(sendKeepalive, KEEPALIVE_MS);
  return () => clearInterval(timer);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
