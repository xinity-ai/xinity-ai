import { config } from "$lib/server/config";
import { isLokiUrl, type Audit } from "$lib/server/config-schema";
import { rootLogger } from "$lib/server/logging";
import { hasFeature } from "$lib/server/license";
import { lokiSink } from "./audit-loki";
import { syslogSink } from "./audit-syslog";
import type { AuditSink } from "./audit-sink";
import type { AuditEvent } from "common-db";

const log = rootLogger.child({ name: "audit.forwarder" });

const BATCH_MAX_EVENTS = 100;
const BATCH_MAX_DELAY_MS = 5_000;
/**
 * Bounds memory while the sink is unreachable. Overflow is a mirroring gap
 * rather than lost data: audit_event still holds every record, so the reported
 * window can be replayed.
 */
const BATCH_MAX_PENDING = 10_000;

let pending: AuditEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let unmirrored = 0;
let unmirroredSince: Date | null = null;

function mirrorTarget(): Audit | null {
  return config.audit && hasFeature("audit-log") ? config.audit : null;
}

export function resolveAuditSink(): AuditSink | null {
  const target = mirrorTarget();
  if (!target) {
    return null;
  }
  return isLokiUrl(target.url) ? lokiSink(target) : syslogSink(target);
}

function reportMirrorGap(until: Date | undefined): void {
  if (unmirrored === 0) {
    return;
  }
  log.error(
    { unmirrored, since: unmirroredSince, until },
    "Audit events in this window never reached the sink and must be replayed from audit_event",
  );
  unmirrored = 0;
  unmirroredSince = null;
}

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

  const sink = resolveAuditSink();
  if (!sink) {
    return;
  }

  try {
    await sink.deliver(batch);
  } catch (err) {
    log.warn({ events: batch.length, sink: sink.name, err }, "Failed to forward audit events");
    return;
  }
  reportMirrorGap(batch.at(-1)?.createdAt);
}

export function forwardAuditEvent(event: AuditEvent): void {
  if (!mirrorTarget()) {
    return;
  }

  if (pending.length >= BATCH_MAX_PENDING) {
    if (unmirrored === 0) {
      unmirroredSince = event.createdAt;
      log.error(
        { limit: BATCH_MAX_PENDING, since: unmirroredSince },
        "Audit forward buffer full, events are no longer reaching the sink",
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
