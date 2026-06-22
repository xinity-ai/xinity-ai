/**
 * `xinity up infra-prometheus`: run Prometheus as a Docker container from a
 * small, fixed-location compose stack. Prometheus is observability infra, not a
 * bare-metal workload, so this avoids per-distro binary/systemd handling; if
 * Docker is absent the environment is reported as unsupported.
 *
 * The container uses host networking so it can scrape the gateway/dashboard/daemon
 * running as host processes on localhost. (Unrelated to the bridge-networked
 * deployment template, whose targets are in-stack.)
 */
import * as p from "./clack.ts";
import pc from "picocolors";
import { type Host } from "./host.ts";
import { pass, fail, info, warn, promptOrUndefined } from "./output.ts";
import { resolveComposeCmd, composeArgs, composeName, stackDir, dockerDaemonReady, tcpPortInUse } from "./docker-stack.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const STACK_DIR = stackDir("prometheus");
const COMPOSE_PATH = `${STACK_DIR}/docker-compose.yml`;
const CONFIG_PATH = `${STACK_DIR}/prometheus.yml`;
const DEFAULT_PORT = 9090;
const CONTAINER_NAME = "xinity-ai-prometheus";
// Pinned to match the deployment/docker monitoring template so both paths run
// the same Prometheus version.
const PROMETHEUS_IMAGE = "prom/prometheus:v3.1.0";
// How often Prometheus re-discovers the daemon set (membership only; metric
// resolution is governed by scrape_interval). The node set changes on the order of
// deployments, so this is deliberately coarse.
const SD_REFRESH_INTERVAL = "3m";

function endpoint(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function scrapeTarget(rawUrl: string): { target: string; scheme: string } {
  const u = new URL(rawUrl);
  const scheme = u.protocol.replace(":", "");
  const port = u.port || (scheme === "https" ? "443" : "80");
  return { target: `${u.hostname}:${port}`, scheme };
}

function parseBasicAuth(value: string): BasicAuth | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const sep = trimmed.indexOf(":");
  if (sep === -1) return { username: trimmed, password: "" };
  return { username: trimmed.slice(0, sep), password: trimmed.slice(sep + 1) };
}

// ─── Health ────────────────────────────────────────────────────────────────

async function isPrometheusRunning(host: Host, port: number): Promise<boolean> {
  const res = await host.run(["curl", "-sf", "-o", "/dev/null", `${endpoint(port)}/-/healthy`]);
  return res.ok;
}

const POLL_INTERVAL_MS = 1000;
const POLL_ATTEMPTS = 30;

async function waitForPrometheusRunning(host: Host, port: number): Promise<boolean> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (await isPrometheusRunning(host, port)) return true;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return false;
}

// ─── Config generation ───────────────────────────────────────────────────────

export type BasicAuth = { username: string; password: string };

/** Render an indented `basic_auth:` block, or a commented placeholder when no creds are given. */
function basicAuthLines(indent: string, auth: BasicAuth | undefined, hint: string): string[] {
  if (!auth) {
    return [
      `${indent}# ${hint}`,
      `${indent}# basic_auth:`,
      `${indent}#   username: <user>`,
      `${indent}#   password: <password>`,
    ];
  }
  return [
    `${indent}basic_auth:`,
    `${indent}  username: ${auth.username}`,
    `${indent}  password: ${auth.password}`,
  ];
}

function schemeLine(scheme: string | undefined): string[] {
  return scheme === "https" ? ["    scheme: https"] : [];
}

export function buildPrometheusConfig(opts: {
  scrapeInterval: string;
  gatewayTarget: string;
  gatewayScheme?: string;
  dashboardTarget: string;
  dashboardScheme?: string;
  daemonSdUrl: string;
  sdAuth?: BasicAuth;
  daemonAuth?: BasicAuth;
}): string {
  const lines: string[] = [
    "global:",
    `  scrape_interval: ${opts.scrapeInterval}`,
    `  evaluation_interval: ${opts.scrapeInterval}`,
    "",
    "scrape_configs:",
    "  - job_name: xinity-gateway",
    ...schemeLine(opts.gatewayScheme),
    "    metrics_path: /metrics",
    "    static_configs:",
    "      - targets:",
    `          - ${opts.gatewayTarget}`,
    "",
    "  - job_name: xinity-dashboard",
    ...schemeLine(opts.dashboardScheme),
    "    metrics_path: /metrics",
    "    static_configs:",
    "      - targets:",
    `          - ${opts.dashboardTarget}`,
    "",
    "  # Daemon targets are discovered dynamically from the dashboard's node",
    "  # registry; this stays current as the node set changes, no edits needed.",
    "  - job_name: xinity-daemon",
    "    metrics_path: /metrics",
    "    http_sd_configs:",
    `      - url: ${opts.daemonSdUrl}`,
    `        refresh_interval: ${SD_REFRESH_INTERVAL}`,
    ...basicAuthLines("        ", opts.sdAuth, "Set if the dashboard's METRICS_AUTH is configured (authenticates the SD request):"),
    ...basicAuthLines("    ", opts.daemonAuth, "Set if the daemons' METRICS_AUTH is configured (authenticates the scrape):"),
  ];

  return lines.join("\n") + "\n";
}

export function buildComposeFile(port: number, configPath: string): string {
  return [
    "# Managed by `xinity up infra-prometheus`. This stack is yours: edit",
    "# prometheus.yml in this directory and run `docker compose restart`, or",
    "# `docker compose down` to remove it. Recreate it any time with the CLI.",
    "#",
    "# Host networking lets Prometheus scrape the gateway/dashboard/daemon that",
    "# run as host processes on localhost. This assumes a Linux host.",
    "services:",
    "  prometheus:",
    `    image: ${PROMETHEUS_IMAGE}`,
    `    container_name: ${CONTAINER_NAME}`,
    "    restart: unless-stopped",
    "    network_mode: host",
    "    command:",
    "      - '--config.file=/etc/prometheus/prometheus.yml'",
    "      - '--storage.tsdb.path=/prometheus'",
    `      - '--web.listen-address=127.0.0.1:${port}'`,
    "      - '--web.enable-lifecycle'",
    "    volumes:",
    `      - ${configPath}:/etc/prometheus/prometheus.yml:ro`,
    "      - xinity-prometheus-data:/prometheus",
    "",
    "volumes:",
    "  xinity-prometheus-data:",
    "",
  ].join("\n");
}

// ─── File writing ──────────────────────────────────────────────────────────

async function writeFile(host: Host, path: string, content: string, label: string): Promise<boolean> {
  const result = await host.withElevation(
    `cat > ${path} << 'XINITY_PROM_EOF'\n${content}\nXINITY_PROM_EOF`,
    `Write ${label}`,
  );
  if (!result.success && !result.skipped) {
    fail("Config", `Failed to write ${label}`);
    return false;
  }
  return true;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Interactive Prometheus setup flow.
 *
 * Returns the Prometheus endpoint URL if the stack was started, or undefined if
 * the user cancelled or the environment is unsupported.
 */
export async function prometheusSetup(
  host: Host,
  dryRun: boolean,
): Promise<string | undefined> {
  p.log.step(pc.bold("Prometheus metrics store setup"));
  p.log.info(
    "Prometheus scrapes the gateway, dashboard, and daemon /metrics endpoints.\n" +
    "It runs as a Docker container and powers the live GPU overlay on the Compute page.",
  );

  // ── Step 1: Require Docker + compose ────────────────────────────────────
  const compose = await resolveComposeCmd(host);
  if (!compose) {
    warn("Docker", "Docker with Compose is required to run the monitoring stack, and was not found.");
    p.log.info(
      pc.dim("  This environment is not supported for CLI-managed Prometheus.\n") +
      pc.dim("  Install Docker (https://docs.docker.com/engine/install/) and re-run,\n") +
      pc.dim("  or run Prometheus yourself and point the dashboard at it via PROMETHEUS_URL."),
    );
    return undefined;
  }
  if (compose.docker === "docker" && !(await dockerDaemonReady(host))) {
    warn("Docker", "The Docker CLI is installed but the daemon is not reachable.");
    p.log.info(
      pc.dim("  Start Docker (e.g. `systemctl start docker`) or ensure your user can\n") +
      pc.dim("  access the Docker socket (docker group), then re-run."),
    );
    return undefined;
  }
  pass("Docker", `Using ${pc.cyan(composeName(compose))}`);

  // ── Step 2: Prompt for configuration ────────────────────────────────────
  p.log.step(pc.bold("Configure Prometheus"));

  const portStr = await promptOrUndefined(p.text({
    message: "Prometheus port (bound to localhost)",
    placeholder: String(DEFAULT_PORT),
    defaultValue: String(DEFAULT_PORT),
  }));
  if (portStr === undefined) return undefined;
  const port = Number(portStr) || DEFAULT_PORT;

  if (!(await isPrometheusRunning(host, port)) && (await tcpPortInUse(host, port))) {
    warn("Port", `Port ${port} is already in use. Prometheus may fail to start; choose a different port or stop the process using it.`);
  }

  const validateUrl = (value: string | undefined): string | undefined => {
    let u: URL;
    try {
      u = new URL(value ?? "");
    } catch {
      return "Enter a full URL, e.g. http://localhost:4121";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "URL must start with http:// or https://";
    return undefined;
  };

  const gatewayUrl = await promptOrUndefined(p.text({
    message: "Gateway base URL",
    placeholder: "http://localhost:4121",
    defaultValue: "http://localhost:4121",
    validate: validateUrl,
  }));
  if (gatewayUrl === undefined) return undefined;

  const dashboardUrl = await promptOrUndefined(p.text({
    message: "Dashboard base URL",
    placeholder: "http://localhost:5121",
    defaultValue: "http://localhost:5121",
    validate: validateUrl,
  }));
  if (dashboardUrl === undefined) return undefined;

  const gateway = scrapeTarget(gatewayUrl);
  const dashboard = scrapeTarget(dashboardUrl);

  // Daemons are discovered dynamically from the dashboard, so there is no static
  // target list to maintain. Auth is optional: the SD endpoint is often left open
  // (internal only), while the daemon scrape is usually password-protected.
  const sdAuthRaw = await promptOrUndefined(p.text({
    message: "Dashboard METRICS_AUTH for the discovery request (user:pass, blank if none)",
    placeholder: "",
    defaultValue: "",
  }));
  if (sdAuthRaw === undefined) return undefined;

  const daemonAuthRaw = await promptOrUndefined(p.text({
    message: "Daemon METRICS_AUTH for scraping daemons (user:pass, blank if none)",
    placeholder: "",
    defaultValue: "",
  }));
  if (daemonAuthRaw === undefined) return undefined;

  const daemonSdUrl = new URL("/metrics/sd/daemons", dashboardUrl).href;
  const config = buildPrometheusConfig({
    scrapeInterval: "30s",
    gatewayTarget: gateway.target,
    gatewayScheme: gateway.scheme,
    dashboardTarget: dashboard.target,
    dashboardScheme: dashboard.scheme,
    daemonSdUrl,
    sdAuth: parseBasicAuth(sdAuthRaw),
    daemonAuth: parseBasicAuth(daemonAuthRaw),
  });
  const composeFile = buildComposeFile(port, CONFIG_PATH);

  // ── Step 3: Write the stack ─────────────────────────────────────────────
  if (dryRun) {
    info("Dry run", `Would write ${CONFIG_PATH} and ${COMPOSE_PATH}`);
    info("Dry run", `Would run: ${pc.dim(composeArgs(compose, COMPOSE_PATH, "up", "-d").join(" "))}`);
    return endpoint(port);
  }

  await host.withElevation(`mkdir -p ${STACK_DIR}`, "Create stack directory");
  if (!(await writeFile(host, CONFIG_PATH, config, "Prometheus scrape config"))) return undefined;
  if (!(await writeFile(host, COMPOSE_PATH, composeFile, "monitoring compose file"))) return undefined;
  pass("Config", `Wrote ${CONFIG_PATH} and ${COMPOSE_PATH}`);

  // ── Step 4: Bring up the container ──────────────────────────────────────
  const upResult = await host.withElevation(
    composeArgs(compose, COMPOSE_PATH, "up", "-d").join(" "),
    "Start Prometheus container",
  );
  if (!upResult.success && !upResult.skipped) {
    fail("Start", "Failed to start the Prometheus container");
    return undefined;
  }

  const spinner = p.spinner();
  spinner.start("Waiting for Prometheus to start…");
  const ready = await waitForPrometheusRunning(host, port);
  if (ready) {
    spinner.stop("Prometheus is ready");
    pass("Health", `Prometheus reachable at ${endpoint(port)}`);
  } else {
    spinner.stop("Timed out");
    fail("Health", "Prometheus container did not become ready within 30 seconds");
    return undefined;
  }

  const promUrl = endpoint(port);
  const manageCmd = composeArgs(compose, COMPOSE_PATH).join(" ");

  p.note(
    [`PROMETHEUS_URL=${promUrl}`].join("\n"),
    "Add this to your dashboard env file to enable the compute GPU overlay",
  );

  p.log.info(
    `This stack is yours to manage. Files live in ${STACK_DIR}:\n` +
    `  ${pc.cyan(`${manageCmd} restart`)}   (after editing ${CONFIG_PATH})\n` +
    `  ${pc.cyan(`${manageCmd} down`)}      (stop and remove the container)`,
  );

  p.log.info(
    `Daemon targets are discovered from ${pc.cyan(daemonSdUrl)} and refresh automatically\n` +
    `as nodes register or drop out, no edits or reloads needed.`,
  );

  return promUrl;
}
