import postgres from "postgres";
import type { Host } from "./host.ts";

export interface ConnectionResult {
  success: boolean;
  error?: string;
}

const POSTGRES_CONNECT_TIMEOUT_SECONDS = 5;
const REDIS_PING_TIMEOUT_MS = 5000;

export async function testPostgresConnection(url: string, host: Host): Promise<ConnectionResult> {
  const tunnel = await host.openTunnel(url);
  let sql: postgres.Sql | undefined;
  try {
    sql = postgres(tunnel.localUrl, { max: 1, connect_timeout: POSTGRES_CONNECT_TIMEOUT_SECONDS });
    await sql`SELECT 1`;
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  } finally {
    if (sql) {
      await sql.end().catch(() => {});
    }
    await tunnel.close();
  }
}

export async function testRedisConnection(url: string, host: Host): Promise<ConnectionResult> {
  const tunnel = await host.openTunnel(url);
  let client: import("bun").RedisClient | undefined;
  try {
    client = new Bun.RedisClient(tunnel.localUrl, { connectionTimeout: REDIS_PING_TIMEOUT_MS });
    await client.ping();
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  } finally {
    client?.close();
    await tunnel.close();
  }
}
