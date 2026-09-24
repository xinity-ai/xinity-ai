import {
  canonicalStateReport,
  desiredStateSchema,
  KEEPALIVE_INTERVAL_HEADER,
  serviceUrl,
  signRequest,
  STATUS_PATH,
  STREAM_PATH,
  type DesiredState,
  type NodeRegistration,
  type InstallationStateReport,
  type UnsignedInstallationStateReport,
} from "common-env";
import { signPayloadAsNode } from "./statekeeper";
import { rootLogger } from "../logger";
import { receiveConfigEvent } from "./config-feed";
import { config } from "../config";

const log = rootLogger.child({ name: "tether-client" });

const MAX_BACKOFF_MS = 30_000;
const MISSED_KEEPALIVES_BEFORE_RECONNECT = 3;
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * The tether writes its refusals for a human, and this host is the one that can act on them: a
 * clock outside the signature window is only visible from here as a bare 401.
 */
async function refusal(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).trim().slice(0, 300);
}

function signedHeaders(path: string): Record<string, string> {
  return {
    Authorization: signRequest(config.tether.secret, { method: "POST", path }),
    "Content-Type": "application/json",
  };
}

function silenceLimitMs(res: Response): number | null {
  const intervalMs = Number(res.headers.get(KEEPALIVE_INTERVAL_HEADER));
  return intervalMs > 0 ? intervalMs * MISSED_KEEPALIVES_BEFORE_RECONNECT : null;
}

export async function* connectSSE(registration: NodeRegistration): AsyncGenerator<DesiredState> {
  let backoffMs = 1000;
  let warnedUnannouncedKeepalive = false;

  while (true) {
    const abort = new AbortController();
    let silenceTimer: Timer | undefined = setTimeout(() => {
      log.warn({ timeoutMs: HANDSHAKE_TIMEOUT_MS }, "Tether did not answer, reconnecting");
      abort.abort();
    }, HANDSHAKE_TIMEOUT_MS);
    try {
      const res = await fetch(serviceUrl(config.tether.url, STREAM_PATH), {
        method: "POST",
        headers: signedHeaders(STREAM_PATH),
        body: JSON.stringify(registration),
        signal: abort.signal,
      });
      clearTimeout(silenceTimer);

      if (!res.ok) {
        log.error({ status: res.status, refusal: await refusal(res) }, "SSE connection rejected");
        await Bun.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        continue;
      }

      backoffMs = 1000;
      log.info("SSE connection established");

      const limitMs = silenceLimitMs(res);
      if (limitMs === null && !warnedUnannouncedKeepalive) {
        warnedUnannouncedKeepalive = true;
        log.warn("Tether does not announce its keepalive interval, a silently dropped stream will not be detected");
      }
      const armSilenceTimer = () => {
        if (limitMs === null) {
          return;
        }
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          log.warn({ silentMs: limitMs }, "No data from tether, reconnecting");
          abort.abort();
        }, limitMs);
      };

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentData = "";

      armSilenceTimer();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        armSilenceTimer();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6);
          } else if (line === "") {
            if (currentEvent === "state" && currentData) {
              let json: unknown;
              try {
                json = JSON.parse(currentData);
              } catch {
                log.warn("Malformed JSON in SSE data, skipping event");
                currentEvent = "";
                currentData = "";
                continue;
              }
              const parsed = desiredStateSchema.safeParse(json);
              if (parsed.success) {
                yield parsed.data;
              } else {
                log.warn({ error: parsed.error.message }, "Invalid desired state payload");
              }
            } else if (currentEvent === "config" && currentData) {
              receiveConfigEvent(currentData);
            } else if (currentEvent === "superseded") {
              log.warn("Connection superseded by another daemon instance");
            } else if (currentEvent === "shutdown") {
              log.info("Tether shutting down");
            }
            currentEvent = "";
            currentData = "";
          }
        }
      }

      log.warn("SSE connection closed by server");
    } catch (err) {
      if (!abort.signal.aborted) {
        log.error({ err }, "SSE connection error");
      }
    } finally {
      clearTimeout(silenceTimer);
    }

    await Bun.sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    log.info({ backoffMs }, "Reconnecting to tether");
  }
}

export async function reportInstallationStates(report: UnsignedInstallationStateReport): Promise<void> {
  try {
    const signed: InstallationStateReport = {
      ...report,
      signature: await signPayloadAsNode(canonicalStateReport(report)),
    };
    const res = await fetch(serviceUrl(config.tether.url, STATUS_PATH), {
      method: "POST",
      headers: signedHeaders(STATUS_PATH),
      body: JSON.stringify(signed),
    });
    if (!res.ok) {
      log.error({ status: res.status, refusal: await refusal(res) }, "Status POST failed");
    }
  } catch (err) {
    log.error({ err }, "Status POST error");
  }
}
