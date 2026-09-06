import { rootLogger } from "$lib/server/logging";
import { hasFeature } from "$lib/server/license";
import { lokiSink } from "./audit-loki";
import type { AuditSink } from "./audit-sink";
import type { AuditEvent } from "common-db";

const log = rootLogger.child({ name: "audit.forwarder" });

const BATCH_MAX_EVENTS = 100;
const BATCH_MAX_DELAY_MS = 5_000;
/**
 * Bounds memory while the sinks are unreachable. Overflow is a mirroring gap
 * rather than lost data: audit_event still holds every record, so the reported
 * window can be replayed.
 */
const BATCH_MAX_PENDING = 10_000;

let pending: AuditEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let unmirrored = 0;
let unmirroredSince: Date | null = null;

/** Every sink the instance is configured and licensed for. Empty means no mirroring. */
export function resolveAuditSinks(): AuditSink[] {
  if (!hasFeature("audit-log")) {
    return [];
  }
  return [lokiSink()].filter(sink => sink !== null);
}

type SinkFailure = { sink: string; reason: string };

async function deliverBatch(sink: AuditSink, events: AuditEvent[]): Promise<SinkFailure | null> {
  try {
    await sink.deliver(events);
    return null;
  } catch (err) {
    return { sink: sink.name, reason: err instanceof Error ? err.message : String(err) };
  }
}

function reportMirrorGap(until: Date | undefined): void {
  if (unmirrored === 0) {
    return;
  }
  log.error(
    { unmirrored, since: unmirroredSince, until },
    "Audit events in this window never reached a sink and must be replayed from audit_event",
  );
  unmirrored = 0;
  unmirroredSince = null;
}

/** Sends everything buffered so far to every sink. Safe to call when the buffer is empty. */
export async function flushAuditEvents(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const batch = pending;
  if (batch.length === 0) {
    return;
  }
  pending = [];

  const sinks = resolveAuditSinks();
  if (sinks.length === 0) {
    return;
  }

  const failures = (await Promise.all(sinks.map(sink => deliverBatch(sink, batch)))).filter(failure => failure !== null);
  for (const failure of failures) {
    log.warn({ events: batch.length, ...failure }, "Failed to forward audit events");
  }
  if (failures.length < sinks.length) {
    reportMirrorGap(batch.at(-1)?.createdAt);
  }
}

/**
 * Buffers a persisted audit event for the next push.
 * Failures are dropped with a warning; the database holds the authoritative record.
 */
export function forwardAuditEvent(event: AuditEvent): void {
  if (resolveAuditSinks().length === 0) {
    return;
  }

  if (pending.length >= BATCH_MAX_PENDING) {
    if (unmirrored === 0) {
      unmirroredSince = event.createdAt;
      log.error(
        { limit: BATCH_MAX_PENDING, since: unmirroredSince },
        "Audit forward buffer full, events are no longer reaching any sink",
      );
    }
    unmirrored += 1;
    return;
  }
  pending.push(event);

  if (pending.length >= BATCH_MAX_EVENTS) {
    void flushAuditEvents();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => void flushAuditEvents(), BATCH_MAX_DELAY_MS);
    flushTimer.unref?.();
  }
}
