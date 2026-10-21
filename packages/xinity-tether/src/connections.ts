import { aiNodeT, sql } from "common-db";
import type { DesiredState } from "common-env";
import { getDB } from "./db";
import { rootLogger } from "./logger";
import {
  incSSEConnections,
  incDesiredStatePushes,
  observeConnectionDuration,
  setConnectedNodes,
  type DisconnectReason,
} from "./metrics";

const log = rootLogger.child({ name: "connections" });

type ActiveConnection = {
  id: number;
  controller: ReadableStreamDefaultController;
  connectedAt: number;
  lastSeenAt: number;
  publicKey: string;
};

let nextConnectionId = 1;

const connections = new Map<string, ActiveConnection>();

function sseEncode(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

function tryWrite(conn: ActiveConnection, chunk: string): boolean {
  try {
    conn.controller.enqueue(new TextEncoder().encode(chunk));
    return true;
  } catch {
    return false;
  }
}

function recordClose(conn: ActiveConnection, reason: DisconnectReason): void {
  observeConnectionDuration(reason, (Date.now() - conn.connectedAt) / 1000);
}

const pendingAvailabilityWrites = new Map<string, Promise<void>>();

async function writeAvailability(nodeId: string): Promise<void> {
  const available = connections.has(nodeId);
  try {
    await getDB()
      .update(aiNodeT)
      .set({ available })
      .where(sql`${aiNodeT.id} = ${nodeId}`);
  } catch (err) {
    log.error({ err, nodeId, available }, "Failed to update node availability");
  }
}

// Writes for one node run in order and each reads the connection map only when it runs, so a slow
// write from a closed connection can never land after, and undo, the write of the connection replacing it.
function syncAvailability(nodeId: string): Promise<void> {
  const previous = pendingAvailabilityWrites.get(nodeId) ?? Promise.resolve();
  const next = previous.then(() => writeAvailability(nodeId));
  pendingAvailabilityWrites.set(nodeId, next);
  void next.then(() => {
    if (pendingAvailabilityWrites.get(nodeId) === next) {
      pendingAvailabilityWrites.delete(nodeId);
    }
  });
  return next;
}

export async function addConnection(
  nodeId: string,
  controller: ReadableStreamDefaultController,
  publicKey: string,
): Promise<number> {
  const existing = connections.get(nodeId);
  if (existing) {
    log.info({ nodeId }, "Superseding existing SSE connection");
    tryWrite(existing, sseEncode("superseded", "{}"));
    try {
      existing.controller.close();
    } catch {}
    recordClose(existing, "superseded");
  }

  const connId = nextConnectionId++;
  const conn: ActiveConnection = {
    id: connId,
    controller,
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
    publicKey,
  };
  connections.set(nodeId, conn);
  setConnectedNodes(connections.size);
  incSSEConnections();

  log.info({ nodeId, connId }, "Daemon connected");
  void syncAvailability(nodeId);
  return connId;
}

export async function removeConnection(nodeId: string, reason: DisconnectReason, connId?: number): Promise<void> {
  const conn = connections.get(nodeId);
  if (!conn) {
    return;
  }

  if (connId !== undefined && conn.id !== connId) {
    return;
  }

  connections.delete(nodeId);
  setConnectedNodes(connections.size);
  recordClose(conn, reason);

  try {
    conn.controller.close();
  } catch {}

  log.info({ nodeId, connId: conn.id, reason }, "Daemon disconnected");
  await syncAvailability(nodeId);
}

export function pushConfig(nodeId: string, values: Record<string, string>): void {
  const conn = connections.get(nodeId);
  if (!conn) {
    return;
  }
  if (!tryWrite(conn, sseEncode("config", JSON.stringify({ values })))) {
    void removeConnection(nodeId, "write_failed");
  }
}

export function pushConfigToAll(values: Record<string, string>): void {
  for (const nodeId of connections.keys()) {
    pushConfig(nodeId, values);
  }
}

export function pushDesiredState(nodeId: string, state: DesiredState): boolean {
  const conn = connections.get(nodeId);
  if (!conn) {
    return false;
  }

  const ok = tryWrite(conn, sseEncode("state", JSON.stringify(state)));
  if (ok) {
    incDesiredStatePushes();
  } else {
    void removeConnection(nodeId, "write_failed");
  }
  return ok;
}

export function markSeen(nodeId: string): void {
  const conn = connections.get(nodeId);
  if (conn) {
    conn.lastSeenAt = Date.now();
  }
}

// A tick this late means the tether itself was stalled, so daemon silence during it proves nothing.
const STALLED_TICK_FACTOR = 2;

export function runKeepaliveLoop(intervalMs: number, livenessTimeoutMs: () => number): Timer {
  let lastTickAt = Date.now();
  return setInterval(() => {
    const now = Date.now();
    const stalledMs = now - lastTickAt;
    lastTickAt = now;
    if (stalledMs > intervalMs * STALLED_TICK_FACTOR) {
      log.warn({ stalledMs }, "Keepalive loop ran late, restarting every liveness timer instead of expiring nodes");
      for (const conn of connections.values()) {
        conn.lastSeenAt = now;
      }
    }

    for (const [nodeId, conn] of connections) {
      if (now - conn.lastSeenAt > livenessTimeoutMs()) {
        log.warn({ nodeId, silentMs: now - conn.lastSeenAt }, "Liveness timeout");
        void removeConnection(nodeId, "liveness_timeout");
        continue;
      }

      if (!tryWrite(conn, ": keepalive\n\n")) {
        log.info({ nodeId }, "Keepalive write failed");
        void removeConnection(nodeId, "keepalive_failed");
      }
    }
  }, intervalMs);
}

export function isConnected(nodeId: string): boolean {
  return connections.has(nodeId);
}

export function connectedPublicKey(nodeId: string): string | null {
  return connections.get(nodeId)?.publicKey ?? null;
}

export function getConnectedNodeIds(): string[] {
  return [...connections.keys()];
}

export function dropAllConnections(reason: DisconnectReason): void {
  for (const [nodeId, conn] of connections) {
    try {
      conn.controller.close();
    } catch {}
    recordClose(conn, reason);
    connections.delete(nodeId);
  }
  setConnectedNodes(0);
}

export function sendShutdownToAll(): void {
  for (const conn of connections.values()) {
    tryWrite(conn, sseEncode("shutdown", "{}"));
  }
  dropAllConnections("shutdown");
}
