import type { AuditEvent } from "common-db";

/**
 * One configured mirror destination. A sink reports a failed delivery by throwing,
 * which the forwarder logs against `name`. Nothing a sink does reaches the audited action.
 */
export type AuditSink = { name: string; deliver: (events: AuditEvent[]) => Promise<void> };
