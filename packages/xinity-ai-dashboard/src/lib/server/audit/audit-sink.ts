import type { AuditEvent } from "common-db";

/** A sink reports a failed delivery by throwing, which the forwarder logs against `name`. */
export type AuditSink = { name: string; deliver: (events: AuditEvent[]) => Promise<void> };
