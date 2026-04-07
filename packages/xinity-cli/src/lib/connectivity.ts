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
    sql = postgres(tunnel.localUrl, { max: 1, connect_timeout: 5 });
    await sql`SELECT 1`;
    spinner.stop(pc.green("✓") + "  Database connection successful");
    return true;
  } catch (err) {
    spinner.stop(pc.red("✗") + "  Database connection failed");
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
  try {
    const parsed = new URL(tunnel.localUrl);
    const hostname = parsed.hostname;
    const port = parseInt(parsed.port || "6379");
    const password = parsed.password
      ? decodeURIComponent(parsed.password)
      : null;

    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done(false), 5000);

      Bun.connect({
        hostname,
        port,
        socket: {
          data(_socket, data) {
            const response = new TextDecoder().decode(data);
            _socket.end();
            done(response.includes("+PONG") || response.includes("+OK"));
          },
          open(socket) {
            if (password) {
              socket.write(`AUTH ${password}\r\nPING\r\n`);
            } else {
              socket.write("PING\r\n");
            }
          },
          error(_socket) { _socket.end(); done(false); },
          connectError() { done(false); },
        },
      }).catch(() => done(false));
    });

    if (ok) {
      spinner.stop(pc.green("✓") + "  Redis connection successful");
    } else {
      spinner.stop(pc.red("✗") + "  Redis connection failed");
    }
    return ok;
  } catch (err) {
    spinner.stop(pc.red("✗") + "  Redis connection failed");
    p.log.error(pc.dim(String(err)));
    return false;
  } finally {
    await tunnel.close();
  }
}
