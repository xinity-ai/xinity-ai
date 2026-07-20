import { aiNodeT, eq } from "common-db";
import type { DesiredState } from "common-env";
import { getDB } from "./db";
import { rootLogger } from "./logger";
import {
  incSSEConnections,
  incDesiredStatePushes,
  incLivenessTimeouts,
  setConnectedNodes,
} from "./metrics";

const log = rootLogger.child({ name: "connections" });

interface ActiveConnection {
  controller: ReadableStreamDefaultController;
  connectedAt: number;
  lastWriteAt: number;
}

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
): Promise<void> {
  const existing = connections.get(nodeId);
  if (existing) {
    log.info({ nodeId }, "Superseding existing SSE connection");
    tryWrite(existing, sseEncode("superseded", "{}"));
    try {
      existing.controller.close();
    } catch {}
  }

  const conn: ActiveConnection = {
    controller,
    connectedAt: Date.now(),
    lastWriteAt: Date.now(),
  };
  connections.set(nodeId, conn);
  setConnectedNodes(connections.size);
  incSSEConnections();

  log.info({ nodeId }, "Daemon connected");
  await setNodeAvailable(nodeId, true);
}

export async function removeConnection(nodeId: string): Promise<void> {
  const conn = connections.get(nodeId);
  if (!conn) {
    return;
  }

  connections.delete(nodeId);
  setConnectedNodes(connections.size);

  try {
    conn.controller.close();
  } catch {}

  log.info({ nodeId }, "Daemon disconnected");
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
    void removeConnection(nodeId);
  }
  return ok;
}

export function runKeepaliveLoop(intervalMs: number, timeoutMs: number): Timer {
  return setInterval(() => {
    const now = Date.now();
    for (const [nodeId, conn] of connections) {
      if (now - conn.lastWriteAt > timeoutMs) {
        log.warn({ nodeId, silentMs: now - conn.lastWriteAt }, "Liveness timeout");
        incLivenessTimeouts();
        void removeConnection(nodeId);
        continue;
      }

      if (!tryWrite(conn, ": keepalive\n\n")) {
        log.info({ nodeId }, "Keepalive write failed");
        void removeConnection(nodeId);
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
    connections.delete(nodeId);
  }
  setConnectedNodes(0);
}
