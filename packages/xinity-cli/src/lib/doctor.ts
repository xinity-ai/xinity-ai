import postgres from "postgres";

import { expectedMigrationCount } from "common-db";
import { readManifest, type Manifest, type ComponentEntry } from "./manifest.ts";
import { commandExistsOn, isUnitActiveOn, getUnitStatusOn, type Host, createLocalHost } from "./host.ts";
import { analyzeEnvSchema, categorizeFields } from "./env-prompt.ts";
import { parseEnvString } from "./env-file.ts";
import { unitName } from "./systemd.ts";
import { type Component, ENV_SCHEMAS, ENV_DIR, SECRETS_DIR } from "./component-meta.ts";
import { collectRemoteState, createCachedHost } from "./remote-probe.ts";

// Types

export interface DoctorSpinner {
  message: (msg: string) => void;
  stop: () => void;
}

export interface DoctorRunOptions {
  /** Prompt for sudo when permission is denied instead of silently skipping. */
  interactive?: boolean;
  /** Spinner instance for progress updates during collection. */
  spinner?: DoctorSpinner;
  /** Host to run diagnostics on. Defaults to local if not provided. */
  host?: Host;
}

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  label: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface ComponentReport {
  component: string;
  installed: boolean;
  version: string | null;
  checks: CheckResult[];
}

export interface DoctorReport {
  timestamp: string;
  components: ComponentReport[];
  summary: { pass: number; warn: number; fail: number; skip: number };
}

// File helpers

/**
 * Read a file via the host, optionally prompting for sudo when permission is denied.
 * Returns the content, or null with flags indicating why it was unavailable.
 */
async function readFileWithElevation(
  path: string,
  description: string,
  opts: DoctorRunOptions,
): Promise<{ content: string | null; permissionDenied: boolean; skipped: boolean }> {
  const host = opts.host ?? createLocalHost();
  const content = await host.readFile(path);
  if (content !== null) {
    return { content, permissionDenied: false, skipped: false };
  }
  // File not found or inaccessible, try elevated read if interactive
  if (opts.interactive) {
    opts.spinner?.stop();
    const result = await host.withElevation(`cat '${path}'`, description, { sensitive: true });
    if (result.success) {
      return { content: result.output, permissionDenied: false, skipped: false };
    }
    if (result.skipped) {
      return { content: null, permissionDenied: false, skipped: true };
    }
    return { content: null, permissionDenied: true, skipped: false };
  }
  return { content: null, permissionDenied: true, skipped: false };
}

async function checkSystem(host: Host): Promise<ComponentReport> {
  const checks: CheckResult[] = [];

  // Platform: check on the target host, not the local CLI machine
  const unameResult = await host.run(["uname", "-s"]);
  const platform = unameResult.ok ? unameResult.output.trim() : "unknown";
  if (platform === "Linux") {
    checks.push({ label: "Platform", status: "pass", message: "Linux" });
  } else {
    checks.push({
      label: "Platform",
      status: "warn",
      message: `${platform}, some checks may not apply`,
    });
  }

  // systemd
  if (await commandExistsOn(host, "systemctl")) {
    checks.push({
      label: "systemd",
      status: "pass",
      message: "systemctl found",
    });
  } else {
    checks.push({
      label: "systemd",
      status: "fail",
      message: "systemctl not found, service checks will be skipped",
    });
  }

  // Manifest
  const manifest = await readManifest(host);
  const components = Object.keys(manifest.components);
  if (components.length > 0) {
    checks.push({
      label: "Manifest",
      status: "pass",
      message: `${components.length} component(s) installed: ${components.join(", ")}`,
    });
  } else {
    checks.push({
      label: "Manifest",
      status: "warn",
      message: "No components installed (manifest empty or missing)",
    });
  }

  return {
    component: "system",
    installed: true,
    version: null,
    checks,
  };
}

// Connectivity helpers

/**
 * Check Postgres connectivity and migration state in one tunnel + connection.
 */
async function checkPostgresAndMigrations(url: string, host: Host): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const tunnel = await host.openTunnel(url);
  let sql: postgres.Sql | undefined;
  try {
    sql = postgres(tunnel.localUrl, { max: 1, connect_timeout: 5 });
    await sql`SELECT 1`;
    results.push({ label: "PostgreSQL", status: "pass", message: "Connection successful" });

    // Connection worked. Check migrations with the same connection
    const expectedCount = expectedMigrationCount;
    try {
      const rows = await sql`
        SELECT count(*)::int AS count FROM "drizzle"."__drizzle_migrations"
      `;
      const appliedCount = rows[0]?.count ?? 0;

      if (appliedCount === expectedCount) {
        results.push({ label: "DB Migrations", status: "pass", message: `All ${expectedCount} migrations applied` });
      } else if (appliedCount < expectedCount) {
        const pending = expectedCount - appliedCount;
        results.push({
          label: "DB Migrations", status: "fail",
          message: `${appliedCount} of ${expectedCount} applied, ${pending} pending`,
          detail: `Run "xinity up db" to apply pending migrations`,
        });
      } else {
        results.push({
          label: "DB Migrations", status: "warn",
          message: `${appliedCount} applied but only ${expectedCount} expected, CLI may be outdated`,
        });
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes("does not exist")) {
        results.push({
          label: "DB Migrations", status: "fail",
          message: "Migrations table not found, database not initialized",
          detail: `Run "xinity up db" to initialize the database`,
        });
      } else {
        results.push({ label: "DB Migrations", status: "fail", message: "Could not check migration state", detail: msg });
      }
    }
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
  /** Status to use for timeout and connection errors (default: "fail"). */
  failStatus?: CheckStatus;
  timeoutMs?: number;
  /** Called when the socket opens. Send an initial command here, or omit to wait for the server greeting. */
  onOpen?: (socket: { write: (data: string) => void }) => void;
  /** Interpret the first data received. Return a CheckResult (label is filled in automatically). */
  onData: (response: string) => { status: CheckStatus; message: string; detail?: string };
}

function probeTcpService(opts: TcpProbeOptions): Promise<CheckResult> {
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

async function checkRedis(url: string, host: Host): Promise<CheckResult> {
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



/**
 * Check an HTTP endpoint that lives on the target host (e.g. localhost:PORT/health).
 * Routes the request through `host.run(['curl', ...])` so it is executed on the
 * correct machine rather than the CLI machine.
 */
async function checkServiceHealth(
  host: Host,
  label: string,
  url: string,
): Promise<CheckResult> {
  const result = await host.run([
    "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
    "--connect-timeout", "5", "--max-time", "5",
    url,
  ]);
  const statusCode = parseInt(result.output.trim());
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

function isLocalUrl(url: string, expectedPort: string): boolean {
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

async function checkSmtp(url: string, host: Host): Promise<CheckResult> {
  const tunnel = await host.openTunnel(url);
  try {
    const parsed = new URL(tunnel.localUrl);
    const hostname = parsed.hostname;
    const port = parseInt(parsed.port || "587");

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

async function checkInfoserverUrl(
  url: string,
  host: Host,
  labelSuffix?: string,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const suffix = labelSuffix ? ` (${labelSuffix})` : "";

  // Health
  checks.push(await checkServiceHealth(host, `Health${suffix}`, `${url}/health`));

  // Version - use curl on the target host to fetch JSON
  const versionResult = await host.run([
    "curl", "-sf", "--connect-timeout", "5", "--max-time", "5", `${url}/version.json`,
  ]);
  if (versionResult.ok) {
    try {
      const data = JSON.parse(versionResult.output) as { version?: string };
      checks.push({
        label: `Version${suffix}`,
        status: "pass",
        message: data.version ?? "unknown",
      });
    } catch {
      checks.push({
        label: `Version${suffix}`,
        status: "warn",
        message: "Could not parse version response",
      });
    }
  } else {
    checks.push({
      label: `Version${suffix}`,
      status: "warn",
      message: "Could not fetch version",
    });
  }

  // Model catalog
  checks.push(
    await checkServiceHealth(host, `Model catalog${suffix}`, `${url}/models/v1.json`),
  );

  return checks;
}

/**
 * Check installation state: binary exists, systemd unit exists, service running.
 */
async function checkInstallation(
  component: Component,
  entry: ComponentEntry,
  host: Host,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const hasSystemd = await commandExistsOn(host, "systemctl");

  // Binary / files exist
  if (await host.fileExists(entry.binaryPath)) {
    checks.push({
      label: "Binary",
      status: "pass",
      message: entry.binaryPath,
    });
  } else {
    checks.push({
      label: "Binary",
      status: "fail",
      message: `Not found at ${entry.binaryPath}`,
    });
  }

  // Systemd unit file
  const unitPath = `/etc/systemd/system/${unitName(component)}`;
  if (await host.fileExists(unitPath)) {
    checks.push({
      label: "Systemd unit",
      status: "pass",
      message: unitName(component),
    });
  } else {
    checks.push({
      label: "Systemd unit",
      status: "fail",
      message: `Unit file not found at ${unitPath}`,
    });
  }

  // Service active
  if (hasSystemd) {
    const status = await getUnitStatusOn(host, unitName(component));
    if (status === "active") {
      checks.push({ label: "Service", status: "pass", message: "active" });
    } else {
      checks.push({
        label: "Service",
        status: "fail",
        message: status || "inactive",
      });
    }
  } else {
    checks.push({
      label: "Service",
      status: "skip",
      message: "systemd not available",
    });
  }

  return checks;
}

/**
 * Check env config: file exists, readable, required keys present, secrets exist.
 * When opts.interactive is true and a file is permission-denied, prompts for sudo.
 */
async function checkConfiguration(
  component: Component,
  opts: DoctorRunOptions,
): Promise<{
  checks: CheckResult[];
  values: Record<string, string>;
  permissionDenied: boolean;
}> {
  const checks: CheckResult[] = [];
  const envPath = `${ENV_DIR}/${component}.env`;

  const host = opts.host ?? createLocalHost();

  // Env file exists
  if (!(await host.fileExists(envPath))) {
    checks.push({
      label: "Env file",
      status: "fail",
      message: `Not found at ${envPath}`,
    });
    return { checks, values: {}, permissionDenied: false };
  }

  // Env file readable (with optional sudo elevation)
  const envRead = await readFileWithElevation(
    envPath,
    `Read ${component} configuration`,
    opts,
  );

  if (envRead.skipped) {
    checks.push({
      label: "Env file",
      status: "skip",
      message: "Skipped",
    });
    return { checks, values: {}, permissionDenied: false };
  }

  if (envRead.permissionDenied) {
    checks.push({
      label: "Env file",
      status: "skip",
      message: "Permission denied, rerun with sudo for full checks",
    });
    return { checks, values: {}, permissionDenied: true };
  }

  const config = envRead.content ? parseEnvString(envRead.content) : {};
  checks.push({ label: "Env file", status: "pass", message: envPath });

  // Check required config keys
  const schema = ENV_SCHEMAS[component];
  const fields = analyzeEnvSchema(schema);
  const { configFields, secretFields } = categorizeFields(fields);

  const missingRequired: string[] = [];
  for (const field of configFields) {
    if (!field.isOptional && !field.hasDefault && !config[field.key]) {
      missingRequired.push(field.key);
    }
  }

  if (missingRequired.length > 0) {
    checks.push({
      label: "Config keys",
      status: "fail",
      message: `Missing required: ${missingRequired.join(", ")}`,
    });
  } else {
    checks.push({
      label: "Config keys",
      status: "pass",
      message: "All required config keys set",
    });
  }

  // Read all secrets, elevating if needed
  let secretsPermDenied = false;
  let secretsSkipped = false;
  let secrets: Record<string, string> = {};

  if (secretFields.length > 0) {
    const host = opts.host ?? createLocalHost();
    if (opts.interactive) {
      opts.spinner?.stop();
      const sr = await readSecrets(host, SECRETS_DIR, secretFields.map((f) => f.key), `Read ${component} secrets`);
      secrets = sr.secrets;
      secretsPermDenied = sr.permissionDenied;
      secretsSkipped = sr.skipped;
    } else {
      // Non-interactive: only try unelevated reads
      for (const field of secretFields) {
        const content = await host.readFile(`${SECRETS_DIR}/${field.key}`);
        if (content !== null) secrets[field.key] = content.trim();
      }
      const missing = secretFields.filter((f) => !(f.key in secrets));
      if (missing.length > 0) secretsPermDenied = true;
    }
  }

  const values = { ...config, ...secrets };

  // Check secrets completeness
  if (secretsPermDenied) {
    checks.push({
      label: "Secrets",
      status: "skip",
      message: "Permission denied, rerun with sudo for full checks",
    });
  } else if (secretsSkipped) {
    checks.push({
      label: "Secrets",
      status: "skip",
      message: "Skipped by user",
    });
  } else {
    const missingSecrets: string[] = [];
    for (const field of secretFields) {
      if (!field.isOptional && !field.hasDefault && !values[field.key]) {
        missingSecrets.push(field.key);
      }
    }
    if (missingSecrets.length > 0) {
      checks.push({
        label: "Secrets",
        status: "fail",
        message: `Missing required: ${missingSecrets.join(", ")}`,
      });
    } else {
      checks.push({
        label: "Secrets",
        status: "pass",
        message: "All required secrets set",
      });
    }
  }

  return { checks, values, permissionDenied: secretsPermDenied };
}

/** Cache for DB check results - avoids re-tunneling and re-querying the same DB multiple times. */
const dbCheckCache = new Map<string, CheckResult[]>();

async function pushDbChecks(checks: CheckResult[], values: Record<string, string>, host: Host): Promise<void> {
  if (!values.DB_CONNECTION_URL) return;
  const url = values.DB_CONNECTION_URL;

  let results = dbCheckCache.get(url);
  if (!results) {
    results = await checkPostgresAndMigrations(url, host);
    dbCheckCache.set(url, results);
  }
  checks.push(...results);
}

const infoserverCheckCache = new Map<string, CheckResult>();

async function pushInfoserverCheck(checks: CheckResult[], values: Record<string, string>, host: Host): Promise<void> {
  if (!values.INFOSERVER_URL) return;
  const url = values.INFOSERVER_URL;

  let result = infoserverCheckCache.get(url);
  if (!result) {
    result = await checkServiceHealth(host, "Infoserver", `${url}/health`);
    infoserverCheckCache.set(url, result);
  }
  checks.push(result);
}

async function checkS3Endpoint(
  endpoint: string,
  host: Host,
): Promise<CheckResult> {
  return checkServiceHealth(host, "S3 endpoint", endpoint + "/");
}

async function checkGatewayConnectivity(
  values: Record<string, string>,
  serviceActive: boolean,
  host: Host,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  await pushDbChecks(checks, values, host);
  if (values.REDIS_URL) checks.push(await checkRedis(values.REDIS_URL, host));
  await pushInfoserverCheck(checks, values, host);
  if (values.S3_ENDPOINT) {
    checks.push(await checkS3Endpoint(values.S3_ENDPOINT, host));
  }
  if (serviceActive) {
    const bindHost = values.HOST || "localhost";
    const port = values.PORT || "4010";
    const checkHost = bindHost === "0.0.0.0" ? "localhost" : bindHost;
    checks.push(await checkServiceHealth(host, "Health endpoint", `http://${checkHost}:${port}/healthCheck`));
  }
  return checks;
}

async function checkSeaweedFSComponent(host: Host): Promise<ComponentReport> {
  const checks: CheckResult[] = [];
  const weedBin = "/opt/xinity/bin/weed";
  const unitFile = "/etc/systemd/system/xinity-ai-seaweedfs.service";
  const hasSystemd = await commandExistsOn(host, "systemctl");

  // Binary
  if (await host.fileExists(weedBin)) {
    checks.push({ label: "Binary", status: "pass", message: weedBin });
  } else if (await commandExistsOn(host, "weed")) {
    checks.push({ label: "Binary", status: "pass", message: "weed found in PATH" });
  } else {
    checks.push({
      label: "Binary",
      status: "fail",
      message: `Not found at ${weedBin}`,
      detail: 'Run "xinity up seaweedfs" to install',
    });
  }

  // Systemd unit
  if (await host.fileExists(unitFile)) {
    checks.push({ label: "Systemd unit", status: "pass", message: "xinity-ai-seaweedfs.service" });
  } else {
    checks.push({ label: "Systemd unit", status: "fail", message: "Unit file not found" });
  }

  // Service active
  if (hasSystemd) {
    const status = await getUnitStatusOn(host, "xinity-ai-seaweedfs.service");
    if (status === "active") {
      checks.push({ label: "Service", status: "pass", message: "active" });
    } else {
      checks.push({ label: "Service", status: "fail", message: status || "inactive" });
    }
  } else {
    checks.push({ label: "Service", status: "skip", message: "systemd not available" });
  }

  // S3 endpoint reachability
  checks.push(await checkServiceHealth(host, "S3 endpoint", "http://127.0.0.1:8333/"));

  const installed = await host.fileExists(weedBin) || await commandExistsOn(host, "weed");
  return { component: "seaweedfs", installed, version: null, checks };
}

async function checkDashboardConnectivity(
  values: Record<string, string>,
  serviceActive: boolean,
  host: Host,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  await pushDbChecks(checks, values, host);
  await pushInfoserverCheck(checks, values, host);
  if (values.MAIL_URL) checks.push(await checkSmtp(values.MAIL_URL, host));
  if (serviceActive) {
    const port = values.HTTP_PORT || "5173";
    checks.push(await checkServiceHealth(host, "Health endpoint", `http://localhost:${port}/api/health`));
  }
  return checks;
}

async function checkDaemonConnectivity(
  values: Record<string, string>,
  serviceActive: boolean,
  host: Host,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  await pushDbChecks(checks, values, host);
  await pushInfoserverCheck(checks, values, host);
  if (serviceActive) {
    const bindHost = values.HOST || "0.0.0.0";
    const port = values.PORT || "4010";
    const checkHost = bindHost === "0.0.0.0" ? "localhost" : bindHost;
    checks.push(await checkServiceHealth(host, "Health endpoint", `http://${checkHost}:${port}/healthCheck`));
  }
  return checks;
}

async function checkInfoserverConnectivity(
  values: Record<string, string>,
  serviceActive: boolean,
  discoveredUrls: { url: string; components: string[] }[],
  host: Host,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const localPort = values.PORT || "8090";

  // Check configured INFOSERVER_URL(s) from other components
  for (const { url, components } of discoveredUrls) {
    const compList = components.join(", ");
    checks.push(
      await checkServiceHealth(host, `Configured URL (${compList})`, `${url}/health`),
    );

    // Warn if the configured URL doesn't point to the local instance
    if (!isLocalUrl(url, localPort)) {
      checks.push({
        label: "URL notice",
        status: "warn",
        message: `While the infoserver is installed locally, ${compList} ${components.length > 1 ? "are" : "is"} configured to use: ${url}`,
      });
    }
  }

  // Local self-check: run via host since the service is on the target machine
  if (serviceActive) {
    checks.push(
      await checkServiceHealth(host, "Local health", `http://localhost:${localPort}/health`),
    );
    checks.push(
      await checkServiceHealth(host, "Local model catalog", `http://localhost:${localPort}/models/v1.json`),
    );
  }

  return checks;
}

async function checkDaemonDrivers(
  values: Record<string, string>,
  host: Host,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  // Ollama
  if (values.XINITY_OLLAMA_ENDPOINT) {
    // Binary
    if (await commandExistsOn(host, "ollama")) {
      checks.push({
        label: "Ollama binary",
        status: "pass",
        message: "Found",
      });
    } else {
      checks.push({
        label: "Ollama binary",
        status: "warn",
        message: "Not found in PATH",
      });
    }

    // Service running
    if (
      (await isUnitActiveOn(host, "ollama.service")) ||
      (await isUnitActiveOn(host, "ollama"))
    ) {
      checks.push({
        label: "Ollama service",
        status: "pass",
        message: "Running",
      });
    } else {
      checks.push({
        label: "Ollama service",
        status: "warn",
        message: "Not running",
      });
    }

    // Endpoint reachable: check via host since Ollama runs on the target machine
    checks.push(
      await checkServiceHealth(host, "Ollama endpoint", `${values.XINITY_OLLAMA_ENDPOINT}/api/tags`),
    );
  }

  // vLLM (systemd backend)
  if (values.VLLM_PATH) {
    if (await host.fileExists(values.VLLM_PATH)) {
      checks.push({
        label: "vLLM binary",
        status: "pass",
        message: values.VLLM_PATH,
      });
    } else {
      checks.push({
        label: "vLLM binary",
        status: "warn",
        message: `Not found at ${values.VLLM_PATH}`,
      });
    }
  }

  // vLLM (docker backend)
  if (values.VLLM_DOCKER_IMAGE) {
    // Docker available
    if (await commandExistsOn(host, "docker")) {
      checks.push({
        label: "Docker",
        status: "pass",
        message: "Found",
      });

      // NVIDIA container runtime
      const dockerInfo = await host.run([
        "docker",
        "info",
        "--format",
        "{{json .Runtimes}}",
      ]);
      if (dockerInfo.ok && dockerInfo.output.includes("nvidia")) {
        checks.push({
          label: "NVIDIA container runtime",
          status: "pass",
          message: "Available in Docker",
        });
      } else {
        checks.push({
          label: "NVIDIA container runtime",
          status: "warn",
          message: "Not found in Docker runtimes",
          detail: dockerInfo.output || undefined,
        });
      }
    } else {
      checks.push({
        label: "Docker",
        status: "warn",
        message: "Not found, required for vLLM Docker backend",
      });
    }
  }

  // NVIDIA GPU (check if any driver is configured that may need GPU)
  if (
    values.VLLM_PATH ||
    values.VLLM_DOCKER_IMAGE ||
    values.XINITY_OLLAMA_ENDPOINT
  ) {
    if (await commandExistsOn(host, "nvidia-smi")) {
      const smiResult = await host.run([
        "nvidia-smi",
        "--query-gpu=name",
        "--format=csv,noheader",
      ]);
      if (smiResult.ok) {
        const gpus = smiResult.output
          .split("\n")
          .filter((l) => l.trim())
          .join(", ");
        checks.push({
          label: "NVIDIA GPU",
          status: "pass",
          message: gpus || "Detected",
        });
      } else {
        checks.push({
          label: "NVIDIA GPU",
          status: "warn",
          message: "nvidia-smi found but query failed",
          detail: smiResult.output,
        });
      }
    } else {
      checks.push({
        label: "NVIDIA GPU",
        status: "warn",
        message: "nvidia-smi not found",
      });
    }
  }

  return checks;
}

async function checkComponent(
  component: Component,
  entry: ComponentEntry,
  opts: DoctorRunOptions & { infoserverUrls?: { url: string; components: string[] }[] },
): Promise<{ report: ComponentReport; values: Record<string, string> }> {
  const host = opts.host ?? createLocalHost();
  const checks: CheckResult[] = [];

  // Installation
  checks.push(...(await checkInstallation(component, entry, host)));

  // Configuration
  const configResult = await checkConfiguration(component, opts);
  checks.push(...configResult.checks);

  // Determine if service is active (for connectivity self-checks)
  const serviceActive = await isUnitActiveOn(host, unitName(component)).catch(() => false);

  // Connectivity
  switch (component) {
    case "gateway":
      checks.push(
        ...(await checkGatewayConnectivity(configResult.values, serviceActive, host)),
      );
      break;
    case "dashboard":
      checks.push(
        ...(await checkDashboardConnectivity(configResult.values, serviceActive, host)),
      );
      break;
    case "daemon":
      checks.push(
        ...(await checkDaemonConnectivity(configResult.values, serviceActive, host)),
      );
      checks.push(...(await checkDaemonDrivers(configResult.values, host)));
      break;
    case "infoserver":
      checks.push(
        ...(await checkInfoserverConnectivity(
          configResult.values,
          serviceActive,
          opts?.infoserverUrls ?? [],
          host,
        )),
      );
      break;
  }

  return {
    report: {
      component,
      installed: true,
      version: entry.version,
      checks,
    },
    values: configResult.values,
  };
}


export async function runDoctor(opts: DoctorRunOptions = {}): Promise<DoctorReport> {
  let host = opts.host ?? createLocalHost();
  const components: ComponentReport[] = [];

  // 2. Read manifest (needed before probe to know which components to check)
  const manifest = await readManifest(host);

  // For remote hosts, collect all state in a single SSH call to avoid
  // dozens of individual round-trips (file checks, command checks, unit status).
  if (host.isRemote) {
    opts.spinner?.message("Collecting remote state…");
    const state = await collectRemoteState(host, manifest);
    host = createCachedHost(host, state);
  }

  // 1. System checks
  opts.spinner?.message("Checking system…");
  components.push(await checkSystem(host));

  // 3. Each installable component
  const checkedInfoserverUrls = new Set<string>();
  const remoteInfoserverChecks: CheckResult[] = [];

  // 3a. SeaweedFS (checked independently, not in manifest)
  opts.spinner?.message("Checking SeaweedFS…");
  const seaweedBin = "/opt/xinity/bin/weed";
  const seaweedInstalled = await host.fileExists(seaweedBin) || await commandExistsOn(host, "weed");
  if (seaweedInstalled) {
    components.push(await checkSeaweedFSComponent(host));
  } else {
    components.push({
      component: "seaweedfs",
      installed: false,
      version: null,
      checks: [{ label: "Installed", status: "skip", message: "Not installed (optional, required for multimodal image storage)" }],
    });
  }

  for (const comp of ["gateway", "dashboard", "daemon", "infoserver"] as const) {
    const entry = manifest.components[comp];
    if (!entry) {
      if (comp === "infoserver") {
        // Show remote checks accumulated from other components, or just "Not installed"
        components.push({
          component: "infoserver",
          installed: false,
          version: null,
          checks: remoteInfoserverChecks.length > 0
            ? remoteInfoserverChecks
            : [{ label: "Installed", status: "skip", message: "Not installed" }],
        });
      } else {
        components.push({
          component: comp,
          installed: false,
          version: null,
          checks: [{ label: "Installed", status: "skip", message: "Not installed" }],
        });
      }
      continue;
    }
    opts.spinner?.message(`Checking ${comp}…`);
    const { report, values } = await checkComponent(comp, entry, {
      ...opts,
      host,
      infoserverUrls: [],
    });
    components.push(report);

    // Check each component's infoserver URL (skip duplicates)
    if (comp !== "infoserver" && values.INFOSERVER_URL && !checkedInfoserverUrls.has(values.INFOSERVER_URL)) {
      checkedInfoserverUrls.add(values.INFOSERVER_URL);
      remoteInfoserverChecks.push(...await checkInfoserverUrl(values.INFOSERVER_URL, host, comp));
    }
  }

  // 5. Summary
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const comp of components) {
    for (const check of comp.checks) {
      summary[check.status]++;
    }
  }

  return { timestamp: new Date().toISOString(), components, summary };
}
