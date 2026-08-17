import { serverEnv } from "$lib/server/serverenv";
import { rootLogger } from "$lib/server/logging";
import { hasFeature } from "$lib/server/license";
import { deliverAuditEvents, type LokiTarget } from "./audit-loki";
import type { AuditEvent } from "common-db";

const log = rootLogger.child({ name: "audit.forwarder" });

const BATCH_MAX_EVENTS = 100;
const BATCH_MAX_DELAY_MS = 5_000;
/**
 * Bounds memory while the upstream is unreachable. Overflow is a mirroring gap
 * rather than lost data: audit_event still holds every record, so a backlog
 * worker can replay the reported window once delivery tracking exists.
 */
const BATCH_MAX_PENDING = 10_000;

let pending: AuditEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let unmirrored = 0;
let unmirroredSince: Date | null = null;

export function lokiTargetFromEnv(): LokiTarget | null {
  if (!serverEnv.AUDIT_LOKI_URL || !hasFeature("audit-log")) {
    return null;
  }
  return {
    url: serverEnv.AUDIT_LOKI_URL,
    auth: serverEnv.AUDIT_LOKI_AUTH,
    tenant: serverEnv.AUDIT_LOKI_TENANT,
  };
}

/** Sends everything buffered so far. Safe to call when the buffer is empty. */
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

  const target = lokiTargetFromEnv();
  if (!target) {
    return;
  }

  const delivery = await deliverAuditEvents(batch, target);
  if (!delivery.delivered) {
    log.warn({ events: batch.length, reason: delivery.reason }, "Failed to forward audit events");
    return;
  }
  if (unmirrored > 0) {
    log.error(
      { unmirrored, since: unmirroredSince, until: batch.at(-1)?.createdAt },
      "Audit events in this window never reached the upstream and must be replayed from audit_event",
    );
    unmirrored = 0;
    unmirroredSince = null;
  }
}

/**
 * Buffers a persisted audit event for the next push.
 * Failures are dropped with a warning; the database holds the authoritative record.
 */
export function forwardAuditEvent(event: AuditEvent): void {
  if (!lokiTargetFromEnv()) {
    return;
  }

  if (pending.length >= BATCH_MAX_PENDING) {
    if (unmirrored === 0) {
      unmirroredSince = event.createdAt;
      log.error(
        { limit: BATCH_MAX_PENDING, since: unmirroredSince },
        "Audit forward buffer full, events are no longer reaching the upstream",
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
