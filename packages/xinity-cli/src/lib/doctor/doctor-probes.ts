import postgres from "postgres";
import { expectedMigrationCount } from "common-db";
import { groupMemberHealthSchema, interconnectPortSchema, parseMetricsAuth, tetherConnectionSchema, type GroupMemberHealth, type InterconnectPort, type TetherConnection } from "common-env";
import { getUnitStatusOn, type Host } from "../core/host.ts";
import { defaultPortForProtocol } from "../remote/remote-host.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export type CheckResult = {
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
  if (!tunnel.ok) {
    results.push({ label: "PostgreSQL", status: "fail", message: "Could not open tunnel", detail: tunnel.error });
    return results;
  }
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

export async function checkRedis(url: string, host: Host): Promise<CheckResult> {
  const tunnel = await host.openTunnel(url);
  if (!tunnel.ok) {
    return { label: "Redis", status: "fail", message: "Could not open tunnel", detail: tunnel.error };
  }
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
  curlArgs: readonly string[] = [],
): Promise<CheckResult> {
  const result = await curlStatus(host, url, curlArgs);
  return statusCodeCheck(label, parseInt(result.output.trim(), 10), result.output);
}

const PREDATES_HEALTH = `The service predates /health. Please update it.`;

export async function checkHealthEndpoint(
  host: Host,
  label: string,
  baseUrl: string,
  curlArgs: readonly string[] = [],
): Promise<CheckResult> {
  const result = await curlStatus(host, `${baseUrl}/health`, curlArgs);
  return statusCodeCheck(label, parseInt(result.output.trim(), 10), result.output, PREDATES_HEALTH);
}

function curlStatus(host: Host, url: string, curlArgs: readonly string[]) {
  return host.run([
    "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
    "--connect-timeout", "5", "--max-time", "5",
    ...curlArgs,
    url,
  ]);
}

function statusCodeCheck(label: string, statusCode: number, curlOutput: string, notFoundDetail?: string): CheckResult {
  if (isNaN(statusCode) || statusCode === 0) {
    return {
      label,
      status: "fail",
      message: "Unreachable",
      detail: curlOutput || "curl failed",
    };
  }
  if (statusCode >= 200 && statusCode < 300) {
    return { label, status: "pass", message: `Reachable (${statusCode})` };
  }
  const failed: CheckResult = { label, status: "fail", message: `Returned ${statusCode}` };
  return statusCode === 404 && notFoundDetail ? { ...failed, detail: notFoundDetail } : failed;
}

export type DaemonCoupling = { interconnect: InterconnectPort[]; groupMembers: GroupMemberHealth[] };

export const NO_COUPLING: DaemonCoupling = { interconnect: [], groupMembers: [] };

// Fetched through a tunnel rather than curl on the host, so the credential never reaches a command
// line. Without a credential, or from a daemon that predates a field, there is no check or coupling for it.
export async function probeDaemonHealth(
  host: Host,
  baseUrl: string,
  metricsAuth: string | undefined,
): Promise<{ checks: CheckResult[]; coupling: DaemonCoupling }> {
  const tunnel = await host.openTunnel(baseUrl);
  if (!tunnel.ok) {
    return { checks: [{ label: "Health endpoint", status: "fail", message: "Could not open tunnel", detail: tunnel.error }], coupling: NO_COUPLING };
  }
  const [credential] = parseMetricsAuth(metricsAuth);
  let response: Response;
  try {
    response = await fetch(new URL("/health", tunnel.localUrl), {
      headers: credential ? { authorization: `Basic ${btoa(`${credential.user}:${credential.pass}`)}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    return { checks: [{ label: "Health endpoint", status: "fail", message: "Unreachable", detail: String(err) }], coupling: NO_COUPLING };
  } finally {
    await tunnel.close();
  }
  const health = statusCodeCheck("Health endpoint", response.status, "", PREDATES_HEALTH);
  if (health.status !== "pass") {
    return { checks: [health], coupling: NO_COUPLING };
  }
  const body = parseJson(await response.text());
  const tether = tetherConnectionSchema.safeParse(body?.tether).data;
  return {
    checks: tether ? [health, tetherConnectionCheck(tether)] : [health],
    coupling: {
      interconnect: interconnectPortSchema.array().safeParse(body?.interconnect).data ?? [],
      groupMembers: groupMemberHealthSchema.array().safeParse(body?.groupMembers).data ?? [],
    },
  };
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const TETHER_CONNECTION_CHECKS: Record<TetherConnection["state"], { status: CheckStatus; message: string; detail?: string }> = {
  connected: { status: "pass", message: "Connected" },
  connecting: { status: "warn", message: "Connecting" },
  refused: { status: "fail", message: "Refused", detail: "The daemon logs carry the tether's full refusal." },
  unreachable: { status: "fail", message: "Unreachable", detail: "The daemon logs carry the connection error." },
};

function tetherConnectionCheck(connection: TetherConnection): CheckResult {
  const { status, message, detail } = TETHER_CONNECTION_CHECKS[connection.state];
  const reason = connection.reason ? ` (${connection.reason})` : "";
  return { label: "Tether connection", status, message: `${message}${reason} since ${connection.since}`, detail };
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
  if (!tunnel.ok) {
    return { label: "SMTP", status: "warn", message: "Could not open tunnel", detail: tunnel.error };
  }
  try {
    const parsed = new URL(tunnel.localUrl);
    const implicitTls = parsed.protocol === "smtps:";
    return await new Promise<CheckResult>((resolve) => {
      let settled = false;
      const done = (result: Omit<CheckResult, "label">) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ label: "SMTP", ...result });
      };
      const timer = setTimeout(() => done({ status: "warn", message: "Connection timed out" }), 5000);
      const fail = (error: unknown) => done({ status: "warn", message: "Connection failed", detail: String(error) });

      Bun.connect({
        hostname: parsed.hostname,
        port: parseInt(parsed.port || defaultPortForProtocol(parsed.protocol) || "587", 10),
        tls: implicitTls ? { serverName: new URL(url).hostname } : false,
        socket: {
          data(socket, data) {
            const response = new TextDecoder().decode(data);
            socket.end();
            done(response.startsWith("220")
              ? { status: "pass", message: "SMTP server reachable" }
              : { status: "warn", message: "Unexpected SMTP response", detail: response.trim() });
          },
          error(socket, error) {
            socket.end();
            fail(error);
          },
          connectError(_socket, error) {
            fail(error);
          },
        },
      }).catch(fail);
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
    await checkHealthEndpoint(host, `Health${suffix}`, url),
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
