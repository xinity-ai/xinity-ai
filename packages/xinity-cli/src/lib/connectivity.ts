/**
 * Lightweight connectivity probes for Postgres and Redis.
 *
 * Used during `xinity up` to validate user-provided URLs before
 * persisting them. Reuses the Host tunnel abstraction so the same
 * code works for both local and remote (SSH) hosts.
 */
import postgres from "postgres";
import * as p from "./clack.ts";
import pc from "picocolors";
import type { Host } from "./host.ts";

const okMark = (message: string) => `${pc.green("✓")}  ${message}`;
const failMark = (message: string) => `${pc.red("✗")}  ${message}`;

const POSTGRES_CONNECT_TIMEOUT_SECONDS = 5;
const REDIS_PING_TIMEOUT_MS = 5000;

/**
 * Test PostgreSQL connectivity with a `SELECT 1`.
 * Shows a spinner while connecting. Returns true on success.
 */
export async function testPostgresConnection(url: string, host: Host): Promise<boolean> {
  const tunnel = await host.openTunnel(url);
  const spinner = p.spinner();
  spinner.start("Testing database connection…");
  let sql: postgres.Sql | undefined;
  try {
    sql = postgres(tunnel.localUrl, { max: 1, connect_timeout: POSTGRES_CONNECT_TIMEOUT_SECONDS });
    await sql`SELECT 1`;
    spinner.stop(okMark("Database connection successful"));
    return true;
  } catch (err) {
    spinner.stop(failMark("Database connection failed"));
    p.log.error(pc.dim(String(err)));
    return false;
  } finally {
    if (sql) await sql.end().catch(() => {});
    await tunnel.close();
  }
}

/**
 * Test Redis connectivity with AUTH (if password set) + PING.
 * Shows a spinner while connecting. Returns true on +PONG or +OK.
 */
export async function testRedisConnection(url: string, host: Host): Promise<boolean> {
  const tunnel = await host.openTunnel(url);
  const spinner = p.spinner();
  spinner.start("Testing Redis connection…");
  let client: import("bun").RedisClient | undefined;
  try {
    client = new Bun.RedisClient(tunnel.localUrl, { connectionTimeout: REDIS_PING_TIMEOUT_MS });
    await client.ping();
    spinner.stop(okMark("Redis connection successful"));
    return true;
  } catch (err) {
    spinner.stop(failMark("Redis connection failed"));
    p.log.error(pc.dim(String(err)));
    return false;
  } finally {
    client?.close();
    await tunnel.close();
  }
}
