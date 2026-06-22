/**
 * Interactive Ollama setup for `xinity up infra-ollama` and the daemon step of
 * `xinity up all`. Ollama runs alongside the daemon on the same host, so it is
 * left on its default localhost binding.
 */
import * as p from "./clack.ts";
import pc from "picocolors";
import { type Host, commandExistsOn, isUnitActiveOn } from "./host.ts";
import { pass, fail, info, warn } from "./output.ts";
import { parseEnvString, serializeEnvFile } from "./env-file.ts";
import { ENV_DIR } from "./component-meta.ts";
import { restartService } from "./service.ts";

const DEFAULT_PORT = "11434";
const INSTALL_COMMAND = "curl -fsSL https://ollama.com/install.sh | sh";

/** Endpoint the daemon uses to reach the ollama instance running on the same host. */
export const LOCAL_OLLAMA_ENDPOINT = `http://localhost:${DEFAULT_PORT}`;

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
    if (!result.skipped) {
      fail("Ollama", result.output || "Installation failed");
      p.log.info(pc.dim(`  Install manually: ${INSTALL_COMMAND}`));
    }
    return false;
  }

  pass("Ollama", "Installed successfully");

  // The install script usually starts the service, but not always; wait, then start it ourselves.
  const spinner = p.spinner();
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
  if (!result.skipped) {
    (opts.warnOnFail ? warn : fail)("Ollama", result.output || "Failed to start service");
  }
  return false;
}

// ─── Interactive flows, one per detected state ───────────────────────────────

async function promptInstallOllama(host: Host, dryRun: boolean): Promise<boolean> {
  info("Ollama", "Not found on this system");

  const action = await p.select({
    message: "Ollama is not installed.",
    options: [
      { value: "install", label: "Install ollama", hint: "uses official install script" },
      { value: "skip", label: "Skip" },
    ],
  });
  if (p.isCancel(action) || action === "skip") return false;

  if (dryRun) {
    info("Dry run", `Would install ollama: ${INSTALL_COMMAND}`);
    return true;
  }
  return installOrUpdateOllama(host);
}

async function promptUpdateRunningOllama(host: Host, dryRun: boolean): Promise<boolean> {
  pass("Ollama", "Service is running");

  const action = await p.select({
    message: "Ollama is installed and running.",
    options: [
      { value: "keep", label: "Keep current setup" },
      { value: "update", label: "Update ollama to latest version" },
    ],
  });
  if (p.isCancel(action) || action === "keep") return true;

  if (dryRun) {
    info("Dry run", "Would update ollama");
    return true;
  }
  return installOrUpdateOllama(host);
}

async function promptStartStoppedOllama(host: Host, dryRun: boolean): Promise<boolean> {
  warn("Ollama", "Installed but service is not running");

  const action = await p.select({
    message: "Ollama service is not running.",
    options: [
      { value: "start", label: "Start the service" },
      { value: "update", label: "Update and start" },
    ],
  });
  if (p.isCancel(action)) return false;

  if (dryRun) {
    info("Dry run", `Would ${action} ollama`);
    return true;
  }
  return action === "update" ? installOrUpdateOllama(host) : startOllamaService(host);
}

/**
 * Install/update ollama and ensure its service is running. Returns true when
 * ollama is set up and expected to answer at {@link LOCAL_OLLAMA_ENDPOINT}.
 */
export async function provisionOllama(host: Host, dryRun: boolean): Promise<boolean> {
  p.log.step(pc.bold("Ollama setup"));

  const status = await detectOllamaStatus(host);
  if (status === "missing") return promptInstallOllama(host, dryRun);

  const version = await getOllamaVersion(host);
  pass("Ollama", `Installed${version ? ` (v${version.replace(/^v/, "")})` : ""}`);

  return status === "running"
    ? promptUpdateRunningOllama(host, dryRun)
    : promptStartStoppedOllama(host, dryRun);
}

// ─── Wiring the daemon to ollama (standalone `infra-ollama`) ──────────────────

async function isOllamaEndpointReachable(host: Host): Promise<boolean> {
  const result = await host.runShell(
    `curl -sf --connect-timeout 5 '${LOCAL_OLLAMA_ENDPOINT}/api/tags' > /dev/null`,
  );
  return result.ok;
}

/** Sets XINITY_OLLAMA_ENDPOINT in the daemon env file and restarts the daemon. */
async function writeDaemonEndpoint(host: Host, endpoint: string): Promise<boolean> {
  const envPath = `${ENV_DIR}/daemon.env`;
  const existing = await host.readFile(envPath);
  const env = existing ? parseEnvString(existing) : {};

  if (env.XINITY_OLLAMA_ENDPOINT === endpoint) {
    pass("Daemon config", `XINITY_OLLAMA_ENDPOINT already set to ${endpoint}`);
    return true;
  }

  env.XINITY_OLLAMA_ENDPOINT = endpoint;
  const content = serializeEnvFile(env);
  const result = await host.withElevation(
    `mkdir -p '${ENV_DIR}' && cat > '${envPath}' << 'ENVEOF'\n${content}ENVEOF\nchmod 644 '${envPath}'`,
    "Write XINITY_OLLAMA_ENDPOINT to daemon config",
  );
  if (result.success) {
    pass("Daemon config", `XINITY_OLLAMA_ENDPOINT=${endpoint}`);
    await restartService("daemon", host);
    return true;
  }
  if (!result.skipped) {
    fail("Daemon config", result.output || "Failed to write daemon env");
  }
  return false;
}

/**
 * Point an already-installed daemon at the local ollama instance: confirm the
 * endpoint answers, then persist it to the daemon env.
 */
async function pointDaemonAtOllama(host: Host): Promise<void> {
  if (await isOllamaEndpointReachable(host)) {
    pass("Ollama", `Endpoint reachable at ${LOCAL_OLLAMA_ENDPOINT}`);
  } else {
    warn("Ollama", `Endpoint not reachable at ${LOCAL_OLLAMA_ENDPOINT}. The daemon may not be able to connect.`);
    const proceed = await p.confirm({ message: "Save this endpoint anyway?", initialValue: true });
    if (p.isCancel(proceed) || !proceed) return;
  }
  await writeDaemonEndpoint(host, LOCAL_OLLAMA_ENDPOINT);
}

/** Entry point for `xinity up infra-ollama`: provision ollama, then point the daemon at it. */
export async function ollamaSetup(host: Host, dryRun: boolean): Promise<void> {
  const ready = await provisionOllama(host, dryRun);
  if (ready && !dryRun) await pointDaemonAtOllama(host);
}
