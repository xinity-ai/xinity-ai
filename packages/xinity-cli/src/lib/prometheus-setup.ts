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
import { resolveComposeCmd, composeArgs, composeName, stackDir, dockerDaemonReady } from "./docker-stack.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const STACK_DIR = stackDir("prometheus");
const COMPOSE_PATH = `${STACK_DIR}/docker-compose.yml`;
const CONFIG_PATH = `${STACK_DIR}/prometheus.yml`;
const DEFAULT_PORT = 9090;
const CONTAINER_NAME = "xinity-ai-prometheus";
// Pinned to match the deployment/docker monitoring template so both paths run
// the same Prometheus version.
const PROMETHEUS_IMAGE = "prom/prometheus:v3.1.0";

function endpoint(port: number): string {
  return `http://127.0.0.1:${port}`;
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

export function buildPrometheusConfig(opts: {
  scrapeInterval: string;
  gatewayTarget: string;
  dashboardTarget: string;
  daemonTargets: string[];
}): string {
  const lines: string[] = [
    "global:",
    `  scrape_interval: ${opts.scrapeInterval}`,
    `  evaluation_interval: ${opts.scrapeInterval}`,
    "",
    "scrape_configs:",
    "  - job_name: xinity-gateway",
    "    metrics_path: /metrics",
    "    static_configs:",
    "      - targets:",
    `          - ${opts.gatewayTarget}`,
    "",
    "  - job_name: xinity-dashboard",
    "    metrics_path: /metrics",
    "    static_configs:",
    "      - targets:",
    `          - ${opts.dashboardTarget}`,
    "",
    "  - job_name: xinity-daemon",
    "    metrics_path: /metrics",
    "    static_configs:",
    "      - targets:",
  ];

  if (opts.daemonTargets.length === 0) {
    lines.push("          # Add daemon nodes here, or generate this list from");
    lines.push("          # the dashboard's Instance Settings > Monitoring page.");
    lines.push("          []");
  } else {
    for (const t of opts.daemonTargets) lines.push(`          - ${t}`);
  }

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
    "It runs as a Docker container and powers the live GPU overlay on the Compute fleet page.",
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

  const gatewayTarget = await promptOrUndefined(p.text({
    message: "Gateway /metrics target (host:port)",
    placeholder: "localhost:4121",
    defaultValue: "localhost:4121",
  }));
  if (gatewayTarget === undefined) return undefined;

  const dashboardTarget = await promptOrUndefined(p.text({
    message: "Dashboard /metrics target (host:port)",
    placeholder: "localhost:5121",
    defaultValue: "localhost:5121",
  }));
  if (dashboardTarget === undefined) return undefined;

  const daemonTargetsRaw = await promptOrUndefined(p.text({
    message: "Daemon /metrics targets (comma-separated host:port, optional)",
    placeholder: "10.0.0.5:4010, 10.0.0.6:4010",
    defaultValue: "",
  }));
  if (daemonTargetsRaw === undefined) return undefined;
  const daemonTargets = daemonTargetsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const config = buildPrometheusConfig({ scrapeInterval: "30s", gatewayTarget, dashboardTarget, daemonTargets });
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
    "Add this to your dashboard env file to enable the fleet GPU overlay",
  );

  p.log.info(
    `This stack is yours to manage. Files live in ${STACK_DIR}:\n` +
    `  ${pc.cyan(`${manageCmd} restart`)}   (after editing ${CONFIG_PATH})\n` +
    `  ${pc.cyan(`${manageCmd} down`)}      (stop and remove the container)`,
  );

  if (daemonTargets.length === 0) {
    p.log.info(
      `No daemon targets configured yet. Generate the list from the dashboard's\n` +
      `Instance Settings > Monitoring page, add it to ${CONFIG_PATH}, then run:\n` +
      `  ${pc.cyan(`curl -X POST ${promUrl}/-/reload`)}`,
    );
  }

  return promUrl;
}
