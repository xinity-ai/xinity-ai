import {
  desiredStateSchema,
  serviceUrl,
  type DesiredState,
  type NodeRegistration,
  type InstallationStateReport,
} from "common-env";
import { rootLogger } from "../logger";
import { env } from "../env";

const log = rootLogger.child({ name: "tether-client" });

const MAX_BACKOFF_MS = 30_000;

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${env.TETHER_SECRET}` };
}

export async function* connectSSE(registration: NodeRegistration): AsyncGenerator<DesiredState> {
  let backoffMs = 1000;

  while (true) {
    try {
      const res = await fetch(serviceUrl(env.TETHER_URL, "/api/v1/stream"), {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(registration),
      });

      if (!res.ok) {
        log.error({ status: res.status }, "SSE connection rejected");
        await Bun.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        continue;
      }

      backoffMs = 1000;
      log.info("SSE connection established");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentData = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

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
      log.error({ err }, "SSE connection error");
    }

    await Bun.sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    log.info({ backoffMs }, "Reconnecting to tether");
  }
}

export async function reportInstallationStates(report: InstallationStateReport): Promise<void> {
  try {
    const res = await fetch(serviceUrl(env.TETHER_URL, "/api/v1/status"), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    if (!res.ok) {
      log.error({ status: res.status }, "Status POST failed");
    }
  } catch (err) {
    log.error({ err }, "Status POST error");
  }
}
