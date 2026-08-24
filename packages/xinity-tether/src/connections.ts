import { aiNodeT, eq } from "common-db";
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
  lastWriteAt: number;
};

let nextConnectionId = 1;

const connections = new Map<string, ActiveConnection>();

function sseEncode(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

function tryWrite(conn: ActiveConnection, chunk: string): boolean {
  try {
    conn.controller.enqueue(new TextEncoder().encode(chunk));
    conn.lastWriteAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

function recordClose(conn: ActiveConnection, reason: DisconnectReason): void {
  observeConnectionDuration(reason, (Date.now() - conn.connectedAt) / 1000);
}

async function setNodeAvailable(nodeId: string, available: boolean): Promise<void> {
  try {
    await getDB()
      .update(aiNodeT)
      .set({ available })
      .where(eq(aiNodeT.id, nodeId));
  } catch (err) {
    log.error({ err, nodeId, available }, "Failed to update node availability");
  }
}

export async function addConnection(
  nodeId: string,
  controller: ReadableStreamDefaultController,
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
    lastWriteAt: Date.now(),
  };
  connections.set(nodeId, conn);
  setConnectedNodes(connections.size);
  incSSEConnections();

  log.info({ nodeId, connId }, "Daemon connected");
  await setNodeAvailable(nodeId, true);
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
  await setNodeAvailable(nodeId, false);
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

export function runKeepaliveLoop(intervalMs: number, timeoutMs: number): Timer {
  return setInterval(() => {
    const now = Date.now();
    for (const [nodeId, conn] of connections) {
      if (now - conn.lastWriteAt > timeoutMs) {
        log.warn({ nodeId, silentMs: now - conn.lastWriteAt }, "Liveness timeout");
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

export function getConnectedNodeIds(): string[] {
  return [...connections.keys()];
}

export function sendShutdownToAll(): void {
  for (const [nodeId, conn] of connections) {
    tryWrite(conn, sseEncode("shutdown", "{}"));
    try {
      conn.controller.close();
    } catch {}
    recordClose(conn, "shutdown");
    connections.delete(nodeId);
  }
  setConnectedNodes(0);
}
