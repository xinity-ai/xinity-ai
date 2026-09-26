/**
 * `xinity up infra-ollama` and the daemon step of `xinity up all`. Ollama runs
 * alongside the daemon on the same host, so it is left on its default localhost
 * binding and the daemon finds it by probing {@link DEFAULT_OLLAMA_URL}.
 */
import { isCancel, log, select, spinner as clackSpinner } from "../core/clack.ts";
import { bold, dim } from "picocolors";
import { type Host, commandExistsOn, isUnitActiveOn, waitForReady } from "../core/host.ts";
import { pass, fail, info, warn } from "../core/output.ts";
import { DEFAULT_OLLAMA_URL } from "../core/component-meta.ts";

const INSTALL_COMMAND = "curl -fsSL https://ollama.com/install.sh | sh";
const START_COMMAND = "systemctl enable --now ollama";

type OllamaStatus = "missing" | "stopped" | "running";

export type OllamaAction = "install" | "update" | "start" | "none";

// ─── Detection ──────────────────────────────────────────────────────────────

export async function isOllamaRunning(host: Host): Promise<boolean> {
  return (
    (await isUnitActiveOn(host, "ollama.service")) ||
    (await isUnitActiveOn(host, "ollama"))
  );
}

async function detectOllamaStatus(host: Host): Promise<OllamaStatus> {
  if (!(await commandExistsOn(host, "ollama"))) return "missing";
  return (await isOllamaRunning(host)) ? "running" : "stopped";
}

async function getOllamaVersion(host: Host): Promise<string | null> {
  const result = await host.run(["ollama", "--version"]);
  if (!result.ok) return null;
  const match = result.output.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? result.output.trim();
}

// ─── Plan ───────────────────────────────────────────────────────────────────

async function planInteractive(status: OllamaStatus): Promise<OllamaAction | undefined> {
  if (status === "missing") {
    info("Ollama", "Not found on this system");
    const action = await select({
      message: "Ollama is not installed.",
      options: [
        { value: "install", label: "Install ollama", hint: "uses official install script" },
        { value: "skip", label: "Skip" },
      ],
    });
    return isCancel(action) || action === "skip" ? undefined : "install";
  }

  if (status === "running") {
    pass("Ollama", "Service is running");
    const action = await select({
      message: "Ollama is installed and running.",
      options: [
        { value: "keep", label: "Keep current setup" },
        { value: "update", label: "Update ollama to latest version" },
      ],
    });
    // Cancelling an already-working setup keeps it, rather than reporting failure.
    return isCancel(action) || action === "keep" ? "none" : "update";
  }

  warn("Ollama", "Installed but service is not running");
  const action = await select({
    message: "Ollama service is not running.",
    options: [
      { value: "start", label: "Start the service" },
      { value: "update", label: "Update and start" },
    ],
  });
  if (isCancel(action)) return undefined;
  return action === "update" ? "update" : "start";
}

export async function planOllama(
  host: Host,
  opts: { interactive: boolean },
): Promise<OllamaAction | undefined> {
  log.step(bold("Ollama setup"));
  const status = await detectOllamaStatus(host);

  if (status !== "missing") {
    const version = await getOllamaVersion(host);
    pass("Ollama", `Installed${version ? ` (v${version.replace(/^v/, "")})` : ""}`);
  }

  if (opts.interactive) return planInteractive(status);

  if (status === "missing") {
    info("Ollama", "Not found, installing");
    return "install";
  }
  if (status === "running") {
    pass("Ollama", "Service is running");
    return "none";
  }
  return "start";
}

export function describeOllama(action: OllamaAction): string | undefined {
  if (action === "none") return undefined;
  if (action === "start") return "Start the ollama service";
  if (action === "update") return "Update ollama to the latest version and start its service";
  return "Install ollama and start its service";
}

export function buildOllamaCommands(action: OllamaAction): string[] {
  if (action === "none") return [];
  if (action === "start") return [START_COMMAND];
  return [INSTALL_COMMAND, START_COMMAND];
}

// ─── Apply ──────────────────────────────────────────────────────────────────

async function startOllamaService(host: Host, opts: { warnOnFail?: boolean } = {}): Promise<boolean> {
  const result = await host.withElevation(START_COMMAND, "Start ollama service");
  if (result.success) {
    pass("Ollama", "Service started");
    return true;
  }
  (opts.warnOnFail ? warn : fail)("Ollama", result.output || "Failed to start service");
  return false;
}

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
  const running = await waitForReady(() => isOllamaRunning(host), { intervalMs: 500, attempts: 10 });
  spinner.stop(running ? "Service running" : "Service not started automatically");

  if (running) {
    pass("Ollama", "Service is running");
    return true;
  }
  return startOllamaService(host, { warnOnFail: true });
}

export async function applyOllama(action: OllamaAction, host: Host): Promise<boolean> {
  if (action === "none") return true;
  if (action === "start") return startOllamaService(host);
  return installOrUpdateOllama(host);
}

// ─── Confirming the daemon will find ollama ──────────────────────────────────

async function reportDaemonReachability(host: Host): Promise<void> {
  const result = await host.runShell(
    `curl -sf --connect-timeout 5 '${DEFAULT_OLLAMA_URL}/api/tags' > /dev/null`,
  );
  if (result.ok) {
    pass("Ollama", `Endpoint reachable at ${DEFAULT_OLLAMA_URL}, the daemon will pick it up`);
  } else {
    warn("Ollama", `Endpoint not reachable at ${DEFAULT_OLLAMA_URL}. The daemon will not detect the ollama driver.`);
    info("Ollama", "Set OLLAMA_URL in the daemon config if ollama listens elsewhere");
  }
}

// ─── Main entry point ───────────────────────────────────────────────────────

export async function ollamaSetup(host: Host, dryRun: boolean): Promise<void> {
  const action = await planOllama(host, { interactive: true });
  if (action === undefined) return;

  if (dryRun) {
    const commands = buildOllamaCommands(action);
    if (commands.length === 0) {
      info("Dry run", "Ollama is already running, nothing to do");
      return;
    }
    for (const cmd of commands) {
      info("Dry run", `Would run: ${dim(cmd)}`);
    }
    return;
  }

  if (await applyOllama(action, host)) await reportDaemonReachability(host);
}
