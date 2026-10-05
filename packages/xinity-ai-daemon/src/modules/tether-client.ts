import {
  canonicalStateReport,
  desiredStateSchema,
  KEEPALIVE_INTERVAL_HEADER,
  serviceUrl,
  signRequest,
  STATUS_PATH,
  STREAM_PATH,
  tetherRefusalReasonSchema,
  type DesiredState,
  type TetherConnection,
  type TetherRefusal,
  type TetherRefusalReason,
  type NodeRegistration,
  type InstallationStateReport,
  type UnsignedInstallationStateReport,
} from "common-env";
import { rotateNodeIdentity, signPayloadAsNode } from "./statekeeper";
import { rootLogger } from "../logger";
import { receiveConfigEvent } from "./config-feed";
import { config } from "../config";
import { setTimeout as delay } from "node:timers/promises";

const log = rootLogger.child({ name: "tether-client" });

const MAX_BACKOFF_MS = 30_000;
const MISSED_KEEPALIVES_BEFORE_RECONNECT = 3;
const HANDSHAKE_TIMEOUT_MS = 30_000;

// A tether older than the reason field still answers each handshake refusal with its own status.
const HANDSHAKE_REFUSAL_BY_STATUS: Partial<Record<number, TetherRefusalReason>> = {
  400: "invalid_payload",
  401: "unauthorized",
  403: "identity_mismatch",
  405: "method_not_allowed",
  409: "protocol_mismatch",
  503: "registration_failed",
};

type Refusal = { message: string; reason?: TetherRefusalReason };

/**
 * The tether writes its refusals for a human, and this host is the one that can act on them: a
 * clock outside the signature window is only visible from here as a bare 401.
 */
async function readRefusal(res: Response): Promise<Refusal> {
  const text = (await res.text().catch(() => "")).trim();
  let body: Partial<Record<keyof TetherRefusal, unknown>> | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    // An older tether answers some refusals in plain text.
  }
  return {
    message: (typeof body?.error === "string" ? body.error : text).slice(0, 300),
    reason: tetherRefusalReasonSchema.safeParse(body?.reason).data,
  };
}

let connection: TetherConnection = { state: "connecting", since: new Date().toISOString() };

function transition(state: TetherConnection["state"], reason?: TetherRefusalReason): void {
  if (connection.state === state && connection.reason === reason) {
    return;
  }
  connection = { state, reason, since: new Date().toISOString() };
}

export function tetherConnection(): TetherConnection {
  return connection;
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

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal }).catch(() => {});
}

export async function* connectSSE(registration: NodeRegistration, signal: AbortSignal): AsyncGenerator<DesiredState> {
  let backoffMs = 1000;
  let warnedUnannouncedKeepalive = false;
  transition("connecting");

  while (!signal.aborted) {
    const abort = new AbortController();
    let established = false;
    let silenceTimer: Timer | undefined = setTimeout(() => {
      log.warn({ timeoutMs: HANDSHAKE_TIMEOUT_MS }, "Tether did not answer, reconnecting");
      abort.abort();
    }, HANDSHAKE_TIMEOUT_MS);
    try {
      const res = await fetch(serviceUrl(config.tether.url, STREAM_PATH), {
        method: "POST",
        headers: signedHeaders(STREAM_PATH),
        body: JSON.stringify(registration),
        signal: AbortSignal.any([signal, abort.signal]),
      });
      clearTimeout(silenceTimer);

      if (!res.ok) {
        const refusal = await readRefusal(res);
        const reason = refusal.reason ?? HANDSHAKE_REFUSAL_BY_STATUS[res.status];
        log.error({ status: res.status, reason, refusal: refusal.message }, "SSE connection rejected");
        transition("refused", reason);
        if (reason === "identity_mismatch") {
          await rotateNodeIdentity();
          return;
        }
        await pause(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        continue;
      }

      backoffMs = 1000;
      established = true;
      transition("connected");
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
      if (!abort.signal.aborted && !signal.aborted) {
        log.error({ err }, "SSE connection error");
      }
    } finally {
      clearTimeout(silenceTimer);
    }
    transition(established ? "connecting" : "unreachable");

    await pause(backoffMs, signal);
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
      const { message, reason } = await readRefusal(res);
      log.error({ status: res.status, reason, refusal: message }, "Status POST failed");
    }
  } catch (err) {
    log.error({ err }, "Status POST error");
  }
}
