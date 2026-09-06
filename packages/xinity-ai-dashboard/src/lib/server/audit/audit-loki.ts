import { config } from "$lib/server/config";
import type { AuditEvent } from "common-db";
import type { AuditSink } from "./audit-sink";

const PUSH_TIMEOUT_MS = 5_000;

export type LokiTarget = { url: string; auth?: string; tenant?: string };

type StreamLabels = { job: string; action: string; resource: string; result: string };

function streamLabels(event: AuditEvent): StreamLabels {
  return { job: "xinity-audit", action: event.action, resource: event.resource, result: event.result };
}

/**
 * Builds one Loki push body for a batch. Events sharing a label set collapse into
 * a single stream. Labels stay limited to the low-cardinality fields; actor and
 * context land in the line so they cannot multiply the stream count.
 */
export function buildPushPayload(events: AuditEvent[]): string {
  const streams = new Map<string, { stream: StreamLabels; values: [string, string][] }>();

  for (const event of events) {
    const labels = streamLabels(event);
    const key = JSON.stringify([labels.action, labels.resource, labels.result]);
    let stream = streams.get(key);
    if (!stream) {
      stream = { stream: labels, values: [] };
      streams.set(key, stream);
    }
    stream.values.push([(BigInt(event.createdAt.getTime()) * 1_000_000n).toString(), JSON.stringify(event)]);
  }

  return JSON.stringify({ streams: [...streams.values()] });
}

function pushHeaders(target: LokiTarget): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target.auth) {
    headers.Authorization = `Basic ${Buffer.from(target.auth).toString("base64")}`;
  }
  if (target.tenant) {
    headers["X-Scope-OrgID"] = target.tenant;
  }
  return headers;
}

/** Pushes one batch, throwing on a rejected or unreachable endpoint. */
export async function pushToLoki(events: AuditEvent[], target: LokiTarget): Promise<void> {
  const response = await fetch(`${target.url.replace(/\/$/, "")}/loki/api/v1/push`, {
    method: "POST",
    headers: pushHeaders(target),
    body: buildPushPayload(events),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`.trim());
  }
}

export function lokiSink(): AuditSink | null {
  const target = config.audit;
  if (!target) {
    return null;
  }
  return { name: "loki", deliver: events => pushToLoki(events, target) };
}
