/**
 * `xinity up infra-prometheus`. Docker only, by the same rule as PostgreSQL:
 * Prometheus is observability infra rather than a bare-metal workload, so this
 * avoids per-distro binary and systemd handling.
 *
 * The container uses host networking so it can scrape the gateway, dashboard,
 * tether and daemon running as host processes on localhost. (Unrelated to the
 * bridge-networked deployment template, whose targets are in-stack.)
 */
import { log, note, text } from "../core/clack.ts";
import { bold, cyan } from "picocolors";
import { type Host, httpOk } from "../core/host.ts";
import { pass, warn, promptOrUndefined, reportDryRunCommands } from "../core/output.ts";
import { tcpPortInUse, type ComposeCmd } from "./docker-stack.ts";
import {
  type ComposeStack,
  stackPaths, requireCompose, buildWriteFileCommand, writeStackFile,
  startStack, composeUpCommand, composeBaseCommand, localEndpoint,
} from "./compose-service.ts";
import { DASHBOARD_DEFAULT_PORT, GATEWAY_DEFAULT_PORT, TETHER_DEFAULT_PORT } from "../core/component-meta.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const VOLUME_NAME = "xinity-prometheus-data";

// Image pinned to match the deployment/docker monitoring template so both paths
// run the same Prometheus version.
const PROMETHEUS: ComposeStack = {
  name: "prometheus",
  displayName: "Prometheus",
  containerName: "xinity-ai-prometheus",
  image: "prom/prometheus:v3.1.0",
  defaultPort: 9090,
  volumeName: VOLUME_NAME,
};

const { dir: STACK_DIR, composePath: COMPOSE_PATH } = stackPaths(PROMETHEUS);
const CONFIG_PATH = `${STACK_DIR}/prometheus.yml`;

// How often Prometheus re-discovers the daemon set (membership only; metric
// resolution is governed by scrape_interval). The node set changes on the order of
// deployments, so this is deliberately coarse.
const SD_REFRESH_INTERVAL = "3m";

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

function isPrometheusRunning(host: Host, port: number): Promise<boolean> {
  return httpOk(host, `${localEndpoint(port)}/-/healthy`);
}

// ─── Config generation ───────────────────────────────────────────────────────

export type BasicAuth = { username: string; password: string };

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

function staticJobLines(jobName: string, target: string, scheme: string | undefined): string[] {
  return [
    `  - job_name: ${jobName}`,
    ...schemeLine(scheme),
    "    metrics_path: /metrics",
    "    static_configs:",
    "      - targets:",
    `          - ${target}`,
    "",
  ];
}

export function buildPrometheusConfig(opts: {
  scrapeInterval: string;
  gatewayTarget: string;
  gatewayScheme?: string;
  dashboardTarget: string;
  dashboardScheme?: string;
  tetherTarget: string;
  tetherScheme?: string;
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
    ...staticJobLines("xinity-gateway", opts.gatewayTarget, opts.gatewayScheme),
    ...staticJobLines("xinity-dashboard", opts.dashboardTarget, opts.dashboardScheme),
    ...staticJobLines("xinity-tether", opts.tetherTarget, opts.tetherScheme),
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
    `  ${PROMETHEUS.name}:`,
    `    image: ${PROMETHEUS.image}`,
    `    container_name: ${PROMETHEUS.containerName}`,
    "    restart: unless-stopped",
    "    network_mode: host",
    "    command:",
    "      - '--config.file=/etc/prometheus/prometheus.yml'",
    "      - '--storage.tsdb.path=/prometheus'",
    `      - '--web.listen-address=127.0.0.1:${port}'`,
    "      - '--web.enable-lifecycle'",
    "    volumes:",
    `      - ${configPath}:/etc/prometheus/prometheus.yml:ro`,
    `      - ${VOLUME_NAME}:/prometheus`,
    "",
    "volumes:",
    `  ${VOLUME_NAME}:`,
    "",
  ].join("\n");
}

// ─── Provision via Docker ────────────────────────────────────────────────────

export type PrometheusProvision = {
  compose: ComposeCmd;
  port: number;
  url: string;
  daemonSdUrl: string;
  configFile: string;
  composeFile: string;
}

const validateUrl = (value: string | undefined): string | undefined => {
  let u: URL;
  try {
    u = new URL(value ?? "");
  } catch {
    return `Enter a full URL, e.g. http://localhost:${GATEWAY_DEFAULT_PORT}`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "URL must start with http:// or https://";
  return undefined;
};

function promptBaseUrl(message: string, defaultPort: string): Promise<string | undefined> {
  const fallback = `http://localhost:${defaultPort}`;
  return promptOrUndefined(text({ message, placeholder: fallback, defaultValue: fallback, validate: validateUrl }));
}

export async function planPrometheusProvision(host: Host): Promise<PrometheusProvision | undefined> {
  const compose = await requireCompose(host, PROMETHEUS, {
    requiredTo: "run the monitoring stack",
    fallbackHint: "or run Prometheus yourself and point the dashboard at it via PROMETHEUS_URL.",
  });
  if (!compose) return undefined;

  log.step(bold("Configure Prometheus"));

  const portStr = await promptOrUndefined(text({
    message: "Prometheus port (bound to localhost)",
    placeholder: String(PROMETHEUS.defaultPort),
    defaultValue: String(PROMETHEUS.defaultPort),
  }));
  if (portStr === undefined) return undefined;
  const port = Number(portStr) || PROMETHEUS.defaultPort;

  // An already-running Prometheus on this port is a re-run, not a clash.
  if (!(await isPrometheusRunning(host, port)) && (await tcpPortInUse(host, port))) {
    warn("Port", `Port ${port} is already in use. Prometheus may fail to start; choose a different port or stop the process using it.`);
  }

  const gatewayUrl = await promptBaseUrl("Gateway base URL", GATEWAY_DEFAULT_PORT);
  if (gatewayUrl === undefined) return undefined;
  const dashboardUrl = await promptBaseUrl("Dashboard base URL", DASHBOARD_DEFAULT_PORT);
  if (dashboardUrl === undefined) return undefined;
  const tetherUrl = await promptBaseUrl("Tether base URL", TETHER_DEFAULT_PORT);
  if (tetherUrl === undefined) return undefined;

  const gateway = scrapeTarget(gatewayUrl);
  const dashboard = scrapeTarget(dashboardUrl);
  const tether = scrapeTarget(tetherUrl);

  // Daemons are discovered dynamically from the dashboard, so there is no static
  // target list to maintain. Auth is optional: the SD endpoint is often left open
  // (internal only), while the daemon scrape is usually password-protected.
  const sdAuthRaw = await promptOrUndefined(text({
    message: "Dashboard METRICS_AUTH for the discovery request (user:pass, blank if none)",
    placeholder: "",
    defaultValue: "",
  }));
  if (sdAuthRaw === undefined) return undefined;

  const daemonAuthRaw = await promptOrUndefined(text({
    message: "Daemon METRICS_AUTH for scraping daemons (user:pass, blank if none)",
    placeholder: "",
    defaultValue: "",
  }));
  if (daemonAuthRaw === undefined) return undefined;

  const daemonSdUrl = new URL("/metrics/sd/daemons", dashboardUrl).href;
  return {
    compose,
    port,
    url: localEndpoint(port),
    daemonSdUrl,
    configFile: buildPrometheusConfig({
      scrapeInterval: "30s",
      gatewayTarget: gateway.target,
      gatewayScheme: gateway.scheme,
      dashboardTarget: dashboard.target,
      dashboardScheme: dashboard.scheme,
      tetherTarget: tether.target,
      tetherScheme: tether.scheme,
      daemonSdUrl,
      sdAuth: parseBasicAuth(sdAuthRaw),
      daemonAuth: parseBasicAuth(daemonAuthRaw),
    }),
    composeFile: buildComposeFile(port, CONFIG_PATH),
  };
}

export function buildPrometheusProvisionCommands(prov: PrometheusProvision): string[] {
  return [
    `mkdir -p ${STACK_DIR}`,
    buildWriteFileCommand(PROMETHEUS, CONFIG_PATH, prov.configFile),
    buildWriteFileCommand(PROMETHEUS, COMPOSE_PATH, prov.composeFile),
    composeUpCommand(prov.compose, PROMETHEUS),
  ];
}

function reportSuccess(prov: PrometheusProvision): void {
  const manageCmd = composeBaseCommand(prov.compose, PROMETHEUS);
  note(`PROMETHEUS_URL=${prov.url}`, "Add this to your dashboard env file to enable the compute GPU overlay");
  log.info(
    `This stack is yours to manage. Files live in ${STACK_DIR}:\n` +
    `  ${cyan(`${manageCmd} restart`)}   (after editing ${CONFIG_PATH})\n` +
    `  ${cyan(`${manageCmd} down`)}      (stop and remove the container)`,
  );
  log.info(
    `Daemon targets are discovered from ${cyan(prov.daemonSdUrl)} and refresh automatically\n` +
    `as nodes register or drop out, no edits or reloads needed.`,
  );
}

export async function applyPrometheusProvision(prov: PrometheusProvision, host: Host): Promise<boolean> {
  await host.withElevation(`mkdir -p ${STACK_DIR}`, "Create stack directory");
  if (!(await writeStackFile(host, PROMETHEUS, CONFIG_PATH, prov.configFile, "Prometheus scrape config"))) return false;
  if (!(await writeStackFile(host, PROMETHEUS, COMPOSE_PATH, prov.composeFile, "monitoring compose file"))) return false;
  pass("Config", `Wrote ${CONFIG_PATH} and ${COMPOSE_PATH}`);

  const started = await startStack(host, prov.compose, PROMETHEUS, {
    reachableAt: prov.url,
    ready: () => isPrometheusRunning(host, prov.port),
  });
  if (!started) return false;

  reportSuccess(prov);
  return true;
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function prometheusSetup(host: Host, dryRun: boolean): Promise<string | undefined> {
  log.step(bold("Prometheus metrics store setup"));
  log.info(
    "Prometheus scrapes the gateway, dashboard, tether, and daemon /metrics endpoints.\n" +
    "It runs as a Docker container and powers the live GPU overlay on the Compute page.",
  );

  const prov = await planPrometheusProvision(host);
  if (!prov) return undefined;

  if (dryRun) {
    reportDryRunCommands(buildPrometheusProvisionCommands(prov));
    note(`PROMETHEUS_URL=${prov.url}`, "Endpoint (not yet created)");
    return prov.url;
  }

  return (await applyPrometheusProvision(prov, host)) ? prov.url : undefined;
}
