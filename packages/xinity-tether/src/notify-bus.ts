import postgres from "postgres";
import { env } from "./env";
import { rootLogger } from "./logger";
import { buildDesiredState } from "./desired-state";
import { pushDesiredState, isConnected, getConnectionId } from "./connections";

const log = rootLogger.child({ name: "notify-bus" });

let sql: postgres.Sql | null = null;
const subscriptions = new Map<string, postgres.ListenMeta>();

function channelForNode(nodeId: string): string {
  return `ai_node:${nodeId}`;
}

function ensureConnection(): postgres.Sql {
  if (!sql) {
    sql = postgres(env.DB_CONNECTION_URL);
  }
  return sql;
}

export async function subscribe(nodeId: string): Promise<void> {
  if (subscriptions.has(nodeId)) {
    return;
  }

  const channel = channelForNode(nodeId);
  const conn = ensureConnection();

  const handle = await conn.listen(channel, async () => {
    if (!isConnected(nodeId)) {
      return;
    }
    try {
      const state = await buildDesiredState(nodeId);
      pushDesiredState(nodeId, state);
    } catch (err) {
      log.error({ err, nodeId }, "Failed to push desired state after notification");
    }
  });

  subscriptions.set(nodeId, handle);
  log.debug({ nodeId, channel }, "Subscribed to notifications");
}

export async function unsubscribe(nodeId: string, connId?: number): Promise<void> {
  const handle = subscriptions.get(nodeId);
  if (!handle) {
    return;
  }

  if (connId !== undefined && isConnected(nodeId)) {
    const current = getConnectionId(nodeId);
    if (current !== undefined && current !== connId) {
      log.debug({ nodeId, connId, currentConnId: current }, "Skipping unsubscribe for superseded connection");
      return;
    }
  }

  try {
    await handle.unlisten();
  } catch (err) {
    log.warn({ err, nodeId }, "Failed to unlisten");
  }
  subscriptions.delete(nodeId);
  log.debug({ nodeId }, "Unsubscribed from notifications");
}

export async function shutdown(): Promise<void> {
  for (const [nodeId, handle] of subscriptions) {
    try {
      await handle.unlisten();
    } catch {}
    subscriptions.delete(nodeId);
  }

  if (sql) {
    await sql.end();
    sql = null;
  }
}
