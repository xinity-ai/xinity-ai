import postgres from "postgres";
import { expectedMigrationCount } from "common-db";
import { getUnitStatusOn, type Host } from "./host.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  label: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export async function probeMigrationState(sql: postgres.Sql): Promise<CheckResult> {
  const expected = expectedMigrationCount;
  try {
    const rows = await sql`SELECT count(*)::int AS count FROM "drizzle"."__drizzle_migrations"`;
    const applied = rows[0]?.count ?? 0;

    if (applied === expected) {
      return { label: "DB Migrations", status: "pass", message: `All ${expected} migrations applied` };
    }
    if (applied < expected) {
      return {
        label: "DB Migrations", status: "fail",
        message: `${applied} of ${expected} applied, ${expected - applied} pending`,
        detail: `Run "xinity up db" to apply pending migrations`,
      };
    }
    return {
      label: "DB Migrations", status: "warn",
      message: `${applied} applied but only ${expected} expected, CLI may be outdated`,
    };
  } catch (err) {
    const msg = String(err);
    if (msg.includes("does not exist")) {
      return {
        label: "DB Migrations", status: "fail",
        message: "Migrations table not found, database not initialized",
        detail: `Run "xinity up db" to initialize the database`,
      };
    }
    return { label: "DB Migrations", status: "fail", message: "Could not check migration state", detail: msg };
  }
}

export async function checkPostgresAndMigrations(url: string, host: Host): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const tunnel = await host.openTunnel(url);
  let sql: postgres.Sql | undefined;
  try {
    sql = postgres(tunnel.localUrl, { max: 1, connect_timeout: 5 });
    await sql`SELECT 1`;
    results.push({ label: "PostgreSQL", status: "pass", message: "Connection successful" });
    results.push(await probeMigrationState(sql));
  } catch (err) {
    results.push({ label: "PostgreSQL", status: "fail", message: "Connection failed", detail: String(err) });
  } finally {
    if (sql) await sql.end().catch(() => {});
    await tunnel.close();
  }
  return results;
}

interface TcpProbeOptions {
  hostname: string;
  port: number;
  label: string;
  failStatus?: CheckStatus;
  timeoutMs?: number;
  onOpen?: (socket: { write: (data: string) => void }) => void;
  onData: (response: string) => { status: CheckStatus; message: string; detail?: string };
}

export function probeTcpService(opts: TcpProbeOptions): Promise<CheckResult> {
  const { hostname, port, label, timeoutMs = 5000 } = opts;
  const failStatus = opts.failStatus ?? "fail";

  return new Promise<CheckResult>((resolve) => {
    let settled = false;
    const done = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      done({ label, status: failStatus, message: "Connection timed out" });
    }, timeoutMs);

    const fail = (error: unknown) => {
      done({ label, status: failStatus, message: "Connection failed", detail: String(error) });
    };

    Bun.connect({
      hostname,
      port,
      socket: {
        data(_socket, data) {
          const response = new TextDecoder().decode(data);
          _socket.end();
          done({ label, ...opts.onData(response) });
        },
        open(socket) {
          opts.onOpen?.(socket);
        },
        error(_socket, error) {
          _socket.end();
          fail(error);
        },
        connectError(_socket, error) {
          fail(error);
        },
      },
    }).catch(fail);
  });
}

export async function checkRedis(url: string, host: Host): Promise<CheckResult> {
  const tunnel = await host.openTunnel(url);
  let client: import("bun").RedisClient | undefined;
  try {
    client = new Bun.RedisClient(tunnel.localUrl);
    await client.ping();
    return { label: "Redis", status: "pass", message: "PING/PONG successful" };
  } catch (err) {
    return {
      label: "Redis",
      status: "fail",
      message: "Connection failed",
      detail: String(err),
    };
  } finally {
    client?.close();
    await tunnel.close();
  }
}

export async function checkServiceHealth(
  host: Host,
  label: string,
  url: string,
): Promise<CheckResult> {
  const result = await host.run([
    "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
    "--connect-timeout", "5", "--max-time", "5",
    url,
  ]);
  const statusCode = parseInt(result.output.trim(), 10);
  if (isNaN(statusCode) || statusCode === 0) {
    return {
      label,
      status: "fail",
      message: "Unreachable",
      detail: result.output || "curl failed",
    };
  }
  if (statusCode >= 200 && statusCode < 300) {
    return { label, status: "pass", message: `Reachable (${statusCode})` };
  }
  return { label, status: "fail", message: `Returned ${statusCode}` };
}

export function isLocalUrl(url: string, expectedPort: string): boolean {
  try {
    const parsed = new URL(url);
    const localHosts = ["localhost", "127.0.0.1", "::1"];
    const urlPort =
      parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return localHosts.includes(parsed.hostname) && urlPort === expectedPort;
  } catch {
    return false;
  }
}

export async function checkSmtp(url: string, host: Host): Promise<CheckResult> {
  const tunnel = await host.openTunnel(url);
  try {
    const parsed = new URL(tunnel.localUrl);
    const hostname = parsed.hostname;
    const port = parseInt(parsed.port || "587", 10);

    return await probeTcpService({
      hostname,
      port,
      label: "SMTP",
      failStatus: "warn",
      onData(response) {
        if (response.startsWith("220")) {
          return { status: "pass", message: "SMTP server reachable" };
        }
        return { status: "warn", message: "Unexpected SMTP response", detail: response.trim() };
      },
    });
  } catch (err) {
    return {
      label: "SMTP",
      status: "warn",
      message: "Invalid SMTP URL",
      detail: String(err),
    };
  } finally {
    await tunnel.close();
  }
}

export async function probeInfoserverVersion(host: Host, baseUrl: string, label: string): Promise<CheckResult> {
  const result = await host.run([
    "curl", "-sf", "--connect-timeout", "5", "--max-time", "5", `${baseUrl}/version.json`,
  ]);
  if (!result.ok) {
    return { label, status: "warn", message: "Could not fetch version" };
  }
  try {
    const data = JSON.parse(result.output) as { version?: string };
    return { label, status: "pass", message: data.version ?? "unknown" };
  } catch {
    return { label, status: "warn", message: "Could not parse version response" };
  }
}

export async function checkInfoserverUrl(
  url: string,
  host: Host,
  labelSuffix?: string,
): Promise<CheckResult[]> {
  const suffix = labelSuffix ? ` (${labelSuffix})` : "";
  return [
    await checkServiceHealth(host, `Health${suffix}`, `${url}/health`),
    await probeInfoserverVersion(host, url, `Version${suffix}`),
    await checkServiceHealth(host, `Model catalog${suffix}`, `${url}/models/v1.json`),
  ];
}

export async function fileExistsCheck(
  host: Host,
  label: string,
  path: string,
  presentMessage: string = path,
  missingMessage: string = `Not found at ${path}`,
): Promise<CheckResult> {
  return (await host.fileExists(path))
    ? { label, status: "pass", message: presentMessage }
    : { label, status: "fail", message: missingMessage };
}

export async function serviceActiveCheck(host: Host, unit: string, hasSystemd: boolean): Promise<CheckResult> {
  if (!hasSystemd) {
    return { label: "Service", status: "skip", message: "systemd not available" };
  }
  const status = await getUnitStatusOn(host, unit);
  if (status === "active") {
    return { label: "Service", status: "pass", message: "active" };
  }
  return { label: "Service", status: "fail", message: status || "inactive" };
}

export async function checkS3Endpoint(
  endpoint: string,
  host: Host,
): Promise<CheckResult> {
  return checkServiceHealth(host, "S3 endpoint", endpoint + "/");
}
