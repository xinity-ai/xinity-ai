import { readManifest, type ComponentEntry } from "./manifest.ts";
import { commandExistsOn, isUnitActiveOn, readSecrets, type Host } from "./host.ts";
import { isOllamaRunning } from "./ollama-setup.ts";
import { analyzeEnvSchema, categorizeFields, type EnvField } from "./env-prompt.ts";
import { parseEnvString } from "./env-file.ts";
import { unitName } from "./systemd.ts";
import { type Component, ENV_SCHEMAS, ENV_DIR, SECRETS_DIR, BIN_DIR, UNIT_DIR } from "./component-meta.ts";
import { collectRemoteState, createCachedHost } from "./remote-probe.ts";
import {
  type CheckResult, type CheckStatus,
  checkPostgresAndMigrations, checkRedis, checkServiceHealth, checkSmtp,
  checkInfoserverUrl, checkS3Endpoint,
  fileExistsCheck, serviceActiveCheck, isLocalUrl,
} from "./doctor-probes.ts";

export type { CheckResult, CheckStatus };

export interface DoctorSpinner {
  message: (msg: string) => void;
  stop: () => void;
}

export interface DoctorRunOptions {
  /** Prompt for sudo when permission is denied instead of silently skipping. */
  interactive?: boolean;
  /** Spinner instance for progress updates during collection. */
  spinner?: DoctorSpinner;
  /** Host to run diagnostics on. */
  host: Host;
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

function notInstalledReport(component: string, message = "Not installed"): ComponentReport {
  return {
    component,
    installed: false,
    version: null,
    checks: [{ label: "Installed", status: "skip", message }],
  };
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
  const host = opts.host;
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

async function checkInstallation(
  component: Component,
  entry: ComponentEntry,
  host: Host,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const hasSystemd = await commandExistsOn(host, "systemctl");

  checks.push(await fileExistsCheck(host, "Binary", entry.binaryPath));

  const unitPath = `${UNIT_DIR}/${unitName(component)}`;
  checks.push(await fileExistsCheck(
    host, "Systemd unit", unitPath,
    unitName(component),
    `Unit file not found at ${unitPath}`,
  ));

  checks.push(await serviceActiveCheck(host, unitName(component), hasSystemd));

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

  const host = opts.host;

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

  checks.push(requiredFieldsPresenceCheck("Config keys", "All required config keys set", configFields, config));

  // Read all secrets, elevating if needed
  let secretsPermDenied = false;
  let secretsSkipped = false;
  let secrets: Record<string, string> = {};

  if (secretFields.length > 0) {
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

  if (secretsPermDenied) {
    checks.push({ label: "Secrets", status: "skip", message: "Permission denied, rerun with sudo for full checks" });
  } else if (secretsSkipped) {
    checks.push({ label: "Secrets", status: "skip", message: "Skipped by user" });
  } else {
    checks.push(requiredFieldsPresenceCheck("Secrets", "All required secrets set", secretFields, values));
  }

  return { checks, values, permissionDenied: secretsPermDenied };
}

function requiredFieldsPresenceCheck(
  label: string,
  whenSetMessage: string,
  fields: EnvField[],
  values: Record<string, string>,
): CheckResult {
  const missing = fields
    .filter(f => !f.isOptional && !f.hasDefault && !values[f.key])
    .map(f => f.key);
  if (missing.length > 0) {
    return { label, status: "fail", message: `Missing required: ${missing.join(", ")}` };
  }
  return { label, status: "pass", message: whenSetMessage };
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
  const weedBin = `${BIN_DIR}/weed`;
  const unitFile = `${UNIT_DIR}/xinity-ai-seaweedfs.service`;
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

  checks.push(await serviceActiveCheck(host, "xinity-ai-seaweedfs.service", hasSystemd));

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
    const port = values.PORT || "4044";
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
    if (await isOllamaRunning(host)) {
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

      // GPU container runtime (only check for the vendor actually present)
      const hasNvidiaSmi = await commandExistsOn(host, "nvidia-smi");
      if (hasNvidiaSmi) {
        const rtResult = await host.run(["nvidia-container-runtime", "--version"]);
        if (rtResult.ok) {
          const ver = rtResult.output.split("\n")[0]?.trim() ?? "";
          checks.push({ label: "NVIDIA container runtime", status: "pass", message: ver || "Available" });
        } else {
          checks.push({
            label: "NVIDIA container runtime",
            status: "warn",
            message: "nvidia-container-runtime not found",
            detail: "Install nvidia-container-toolkit: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html",
          });
        }
      }
    } else {
      checks.push({
        label: "Docker",
        status: "warn",
        message: "Not found, required for vLLM Docker backend",
      });
    }
  }

  // GPU detection (check if any driver is configured that may need GPU)
  if (
    values.VLLM_PATH ||
    values.VLLM_DOCKER_IMAGE ||
    values.XINITY_OLLAMA_ENDPOINT
  ) {
    const hasNvidiaSmi = await commandExistsOn(host, "nvidia-smi");
    const hasRocmSmi = await commandExistsOn(host, "rocm-smi");

    if (hasNvidiaSmi) {
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
        checks.push({ label: "NVIDIA GPU", status: "pass", message: gpus || "Detected" });
      } else {
        checks.push({
          label: "NVIDIA GPU",
          status: "warn",
          message: "nvidia-smi found but query failed",
          detail: smiResult.output,
        });
      }
    } else if (hasRocmSmi) {
      const smiResult = await host.run(["rocm-smi", "--showproductname"]);
      if (smiResult.ok) {
        const gpuLine = smiResult.output.split("\n").find((l) => /GPU\[/.test(l) || /Card series/.test(l));
        checks.push({ label: "AMD GPU", status: "pass", message: gpuLine?.trim() || "Detected (ROCm)" });
      } else {
        checks.push({ label: "AMD GPU", status: "warn", message: "rocm-smi found but query failed", detail: smiResult.output });
      }
    } else {
      checks.push({
        label: "GPU",
        status: "warn",
        message: "Neither nvidia-smi nor rocm-smi found",
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
  const host = opts.host;
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


export async function runDoctor(opts: DoctorRunOptions): Promise<DoctorReport> {
  const components: ComponentReport[] = [];

  // 2. Read manifest (needed before probe to know which components to check)
  const manifest = await readManifest(opts.host);

  // Collect all state in a single SSH call to avoid dozens of individual round-trips.
  opts.spinner?.message("Collecting host state…");
  const state = await collectRemoteState(opts.host, manifest);
  const host = createCachedHost(opts.host, state);

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
    components.push(notInstalledReport("seaweedfs", "Not installed (optional, required for multimodal image storage)"));
  }

  for (const comp of ["gateway", "dashboard", "daemon", "infoserver"] as const) {
    const entry = manifest.components[comp];
    if (!entry) {
      if (comp === "infoserver" && remoteInfoserverChecks.length > 0) {
        components.push({ component: "infoserver", installed: false, version: null, checks: remoteInfoserverChecks });
      } else {
        components.push(notInstalledReport(comp));
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
