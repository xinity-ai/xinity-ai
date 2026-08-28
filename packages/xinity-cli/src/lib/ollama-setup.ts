/**
 * Interactive Ollama setup for `xinity up infra-ollama` and the daemon step of
 * `xinity up all`. Ollama runs alongside the daemon on the same host, so it is
 * left on its default localhost binding.
 */
import { isCancel, log, select, spinner as clackSpinner } from "./clack.ts";
import { bold, dim } from "picocolors";
import { type Host, commandExistsOn, isUnitActiveOn } from "./host.ts";
import { pass, fail, info, warn } from "./output.ts";
import { DEFAULT_OLLAMA_URL } from "./component-meta.ts";

const INSTALL_COMMAND = "curl -fsSL https://ollama.com/install.sh | sh";

type OllamaStatus = "missing" | "stopped" | "running";

// ─── Detection ──────────────────────────────────────────────────────────────

async function isOllamaInstalled(host: Host): Promise<boolean> {
  return commandExistsOn(host, "ollama");
}

/** Whether the ollama systemd service is active, accepting either unit name. */
export async function isOllamaRunning(host: Host): Promise<boolean> {
  return (
    (await isUnitActiveOn(host, "ollama.service")) ||
    (await isUnitActiveOn(host, "ollama"))
  );
}

async function detectOllamaStatus(host: Host): Promise<OllamaStatus> {
  if (!(await isOllamaInstalled(host))) return "missing";
  return (await isOllamaRunning(host)) ? "running" : "stopped";
}

const OLLAMA_POLL_INTERVAL_MS = 500;
const OLLAMA_POLL_ATTEMPTS = 10;

/** Poll up to ~5 seconds for the ollama service to become active. Returns true on success. */
export async function waitForOllamaRunning(host: Host): Promise<boolean> {
  for (let i = 0; i < OLLAMA_POLL_ATTEMPTS; i++) {
    await Bun.sleep(OLLAMA_POLL_INTERVAL_MS);
    if (await isOllamaRunning(host)) return true;
  }
  return false;
}

async function getOllamaVersion(host: Host): Promise<string | null> {
  const result = await host.run(["ollama", "--version"]);
  if (!result.ok) return null;
  const match = result.output.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? result.output.trim();
}

// ─── Install / service control ──────────────────────────────────────────────

async function installOrUpdateOllama(host: Host): Promise<boolean> {
  const result = await host.withElevation(INSTALL_COMMAND, "Install/update ollama");
  if (!result.success) {
    fail("Ollama", result.output || "Installation failed");
    log.info(dim(`  Install manually: ${INSTALL_COMMAND}`));
    return false;
  }

  pass("Ollama", "Installed successfully");

  // The install script usually starts the service, but not always; wait, then start it ourselves.
  const spinner = clackSpinner();
  spinner.start("Waiting for ollama service…");
  const running = await waitForOllamaRunning(host);
  spinner.stop(running ? "Service running" : "Service not started automatically");

  if (running) {
    pass("Ollama", "Service is running");
  } else {
    await startOllamaService(host, { warnOnFail: true });
  }
  return true;
}

async function startOllamaService(host: Host, opts: { warnOnFail?: boolean } = {}): Promise<boolean> {
  const result = await host.withElevation("systemctl enable --now ollama", "Start ollama service");
  if (result.success) {
    pass("Ollama", "Service started");
    return true;
  }
  (opts.warnOnFail ? warn : fail)("Ollama", result.output || "Failed to start service");
  return false;
}

// ─── Interactive flows, one per detected state ───────────────────────────────

async function promptInstallOllama(host: Host, dryRun: boolean): Promise<boolean> {
  info("Ollama", "Not found on this system");

  const action = await select({
    message: "Ollama is not installed.",
    options: [
      { value: "install", label: "Install ollama", hint: "uses official install script" },
      { value: "skip", label: "Skip" },
    ],
  });
  if (isCancel(action) || action === "skip") return false;

  if (dryRun) {
    info("Dry run", `Would install ollama: ${INSTALL_COMMAND}`);
    return true;
  }
  return installOrUpdateOllama(host);
}

async function promptUpdateRunningOllama(host: Host, dryRun: boolean): Promise<boolean> {
  pass("Ollama", "Service is running");

  const action = await select({
    message: "Ollama is installed and running.",
    options: [
      { value: "keep", label: "Keep current setup" },
      { value: "update", label: "Update ollama to latest version" },
    ],
  });
  if (isCancel(action) || action === "keep") return true;

  if (dryRun) {
    info("Dry run", "Would update ollama");
    return true;
  }
  return installOrUpdateOllama(host);
}

async function promptStartStoppedOllama(host: Host, dryRun: boolean): Promise<boolean> {
  warn("Ollama", "Installed but service is not running");

  const action = await select({
    message: "Ollama service is not running.",
    options: [
      { value: "start", label: "Start the service" },
      { value: "update", label: "Update and start" },
    ],
  });
  if (isCancel(action)) return false;

  if (dryRun) {
    info("Dry run", `Would ${action} ollama`);
    return true;
  }
  return action === "update" ? installOrUpdateOllama(host) : startOllamaService(host);
}

/**
 * Install/update ollama and ensure its service is running. Returns true when
 * ollama is set up and expected to answer at {@link DEFAULT_OLLAMA_URL}.
 */
export async function provisionOllama(host: Host, dryRun: boolean): Promise<boolean> {
  log.step(bold("Ollama setup"));

  const status = await detectOllamaStatus(host);
  if (status === "missing") return promptInstallOllama(host, dryRun);

  const version = await getOllamaVersion(host);
  pass("Ollama", `Installed${version ? ` (v${version.replace(/^v/, "")})` : ""}`);

  return status === "running"
    ? promptUpdateRunningOllama(host, dryRun)
    : promptStartStoppedOllama(host, dryRun);
}

/**
 * Non-interactive provisioning for `xinity plan apply`: install ollama when
 * missing, start the service when stopped, leave a running instance alone.
 * Returns true when ollama is expected to answer at {@link DEFAULT_OLLAMA_URL}.
 */
export async function ensureOllama(host: Host, dryRun: boolean): Promise<boolean> {
  log.step(bold("Ollama setup"));

  const status = await detectOllamaStatus(host);

  if (dryRun) {
    info("Dry run", status === "missing"
      ? `Would install ollama: ${INSTALL_COMMAND}`
      : status === "stopped" ? "Would start the ollama service" : "Ollama already running");
    return true;
  }

  if (status === "missing") {
    info("Ollama", "Not found, installing");
    return installOrUpdateOllama(host);
  }

  const version = await getOllamaVersion(host);
  pass("Ollama", `Installed${version ? ` (v${version.replace(/^v/, "")})` : ""}`);

  if (status === "running") {
    pass("Ollama", "Service is running");
    return true;
  }
  return startOllamaService(host);
}

// ─── Confirming the daemon will find ollama ──────────────────────────────────

async function isOllamaEndpointReachable(host: Host): Promise<boolean> {
  const result = await host.runShell(
    `curl -sf --connect-timeout 5 '${DEFAULT_OLLAMA_URL}/api/tags' > /dev/null`,
  );
  return result.ok;
}

/**
 * The daemon probes {@link DEFAULT_OLLAMA_URL} on its own, so nothing needs
 * writing. Report whether that probe will find anything.
 */
async function reportDaemonReachability(host: Host): Promise<void> {
  if (await isOllamaEndpointReachable(host)) {
    pass("Ollama", `Endpoint reachable at ${DEFAULT_OLLAMA_URL}, the daemon will pick it up`);
  } else {
    warn("Ollama", `Endpoint not reachable at ${DEFAULT_OLLAMA_URL}. The daemon will not detect the ollama driver.`);
    info("Ollama", "Set OLLAMA_URL in the daemon config if ollama listens elsewhere");
  }
}

/** Entry point for `xinity up infra-ollama`: provision ollama and confirm the daemon can reach it. */
export async function ollamaSetup(host: Host, dryRun: boolean): Promise<void> {
  const ready = await provisionOllama(host, dryRun);
  if (ready && !dryRun) await reportDaemonReachability(host);
}
