import type { InstallationStatePayload, NodeRegistration } from "common-env";
import { flushBatch } from "./writer";

const FLUSH_INTERVAL_MS = 100;
const MAX_BUFFERED_INSTALLATIONS = 1000;

type PerNodeBuffer = {
  registration?: NodeRegistration;
  installations: InstallationStatePayload[];
};

const buffers = new Map<string, PerNodeBuffer>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Returns true if the report was buffered; false on backpressure rejection. */
export function enqueue(nodeId: string, registration: NodeRegistration | undefined, installations: InstallationStatePayload[]): boolean {
  const buf = buffers.get(nodeId) ?? { installations: [] };
  if (buf.installations.length + installations.length > MAX_BUFFERED_INSTALLATIONS) {
    return false;
  }
  if (registration) {
    buf.registration = registration;
  }
  for (const inst of installations) {
    buf.installations.push(inst);
  }
  buffers.set(nodeId, buf);

  if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }
  return true;
}

async function flush(): Promise<void> {
  flushTimer = null;
  const snapshot = Array.from(buffers.entries());
  buffers.clear();

  await Promise.all(snapshot.map(([nodeId, buf]) => flushBatch(nodeId, buf.registration, buf.installations)));
}
