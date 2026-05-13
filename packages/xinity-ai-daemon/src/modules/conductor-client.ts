import { DesiredState, type StatusReport } from "common-env";
import { env } from "../env";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "conductor-client" });

const SSE_RECONNECT_MS = 5_000;

/**
 * True when the daemon has both the conductor URL and a runner token. Dual-write is silently disabled otherwise.
 */
export function conductorConfigured(): boolean {
  return Boolean(env.CONDUCTOR_URL && env.RUNNER_TOKEN);
}

/** Send a status report to the conductor. Errors are logged and swallowed — PG is still the source of truth in dual-write mode. */
export async function reportStatus(report: StatusReport): Promise<void> {
  if (!conductorConfigured()) {
    return;
  }
  try {
    const res = await fetch(`${env.CONDUCTOR_URL}/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.RUNNER_TOKEN}`,
      },
      body: JSON.stringify(report),
    });
    if (!res.ok) {
      log.warn({ status: res.status, body: await res.text().catch(() => "") }, "Conductor rejected status report");
    }
  } catch (err) {
    log.warn({ err }, "Conductor unreachable");
  }
}

/**
 * Stream desired-state updates from the conductor over SSE. Calls `onState` for each fresh state message.
 * Reconnects after a short delay on disconnect; stops when the AbortSignal fires.
 *
 * Dual-read: PG polling stays authoritative in step 011; the callback is for verification only.
 */
export async function streamDesiredState(
  nodeId: string,
  onState: (state: DesiredState) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!conductorConfigured()) {
    return;
  }

  while (!signal.aborted) {
    try {
      const res = await fetch(`${env.CONDUCTOR_URL}/stream`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.RUNNER_TOKEN}`,
          "X-Node-Id": nodeId,
          Accept: "text/event-stream",
        },
        signal,
      });
      if (!res.ok || !res.body) {
        log.warn({ status: res.status }, "Conductor stream connect failed");
      } else {
        await consumeSseStream(res.body, onState);
      }
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      log.warn({ err }, "Conductor stream errored, will retry");
    }
    if (signal.aborted) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, SSE_RECONNECT_MS));
  }
}

async function consumeSseStream(body: ReadableStream<Uint8Array>, onState: (state: DesiredState) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      return;
    }
    buffer += decoder.decode(value, { stream: true });

    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);

      if (line === "") {
        currentEvent = "";
        continue;
      }
      if (line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:") && currentEvent === "state") {
        const payload = line.slice(5).trim();
        try {
          const parsed = DesiredState.safeParse(JSON.parse(payload));
          if (parsed.success) {
            onState(parsed.data);
          } else {
            log.warn({ issues: parsed.error.issues }, "Conductor sent malformed state");
          }
        } catch (err) {
          log.warn({ err }, "Failed to parse SSE state payload");
        }
      }
    }
  }
}
