/**
 * Interactive Ollama setup assistant for `xinity up infra-ollama`.
 *
 * Handles detection, installation, service management, and bind-address
 * configuration via systemd override. After setup, ollama listens on all
 * interfaces so other nodes (gateway, daemon) can reach it.
 */
import * as p from "./clack.ts";
import pc from "picocolors";
import { type Host, commandExistsOn, isUnitActiveOn } from "./host.ts";
import { pass, fail, info, warn } from "./output.ts";
import { parseEnvString, serializeEnvFile } from "./env-file.ts";
import { ENV_DIR } from "./component-meta.ts";
import { restartService } from "./service.ts";

const DEFAULT_PORT = "11434";
const OVERRIDE_DIR = "/etc/systemd/system/ollama.service.d";
const OVERRIDE_PATH = `${OVERRIDE_DIR}/override.conf`;

// ─── Detection ──────────────────────────────────────────────────────────────

async function isOllamaInstalled(host: Host): Promise<boolean> {
  return commandExistsOn(host, "ollama");
}

async function isOllamaRunning(host: Host): Promise<boolean> {
  return (
    (await isUnitActiveOn(host, "ollama.service")) ||
    (await isUnitActiveOn(host, "ollama"))
  );
}

async function getOllamaVersion(host: Host): Promise<string | null> {
  const result = await host.run(["ollama", "--version"]);
  if (!result.ok) return null;
  const match = result.output.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? result.output.trim();
}

async function getCurrentBindAddress(host: Host): Promise<string | null> {
  const content = await host.readFile(OVERRIDE_PATH);
  if (!content) return null;
  const match = content.match(/OLLAMA_HOST=(\S+)/);
  return match?.[1] ?? null;
}

// ─── Install / Update ───────────────────────────────────────────────────────

async function installOrUpdateOllama(host: Host): Promise<boolean> {
  const result = await host.withElevation(
    "curl -fsSL https://ollama.com/install.sh | sh",
    "Install/update ollama",
  );

  if (result.success) {
    pass("Ollama", "Installed successfully");

    // The install script usually starts the service. Poll until it's active.
    const spinner = p.spinner();
    spinner.start("Waiting for ollama service…");
    let running = false;
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(500);
      running = await isOllamaRunning(host);
      if (running) break;
    }
    spinner.stop(running ? "Service running" : "Service not started automatically");

    if (!running) {
      const startResult = await host.withElevation(
        "systemctl enable --now ollama",
        "Start ollama service",
      );
      if (startResult.success) {
        pass("Ollama", "Service started");
      } else if (!startResult.skipped) {
        warn("Ollama", startResult.output || "Failed to start service");
      }
    } else {
      pass("Ollama", "Service is running");
    }
    return true;
  }

  if (!result.skipped) {
    fail("Ollama", result.output || "Installation failed");
    p.log.info(pc.dim("  Install manually: curl -fsSL https://ollama.com/install.sh | sh"));
  }
  return false;
}

// ─── Service management ─────────────────────────────────────────────────────

async function startOllamaService(host: Host): Promise<boolean> {
  const result = await host.withElevation(
    "systemctl enable --now ollama",
    "Start ollama service",
  );
  if (result.success) {
    pass("Ollama", "Service started");
    return true;
  }
  if (!result.skipped) {
    fail("Ollama", result.output || "Failed to start service");
  }
  return false;
}

// ─── Bind address configuration ─────────────────────────────────────────────

/**
 * Write a systemd override so ollama listens on the given address,
 * then reload and restart the service.
 */
async function applyBindAddress(host: Host, bindAddress: string): Promise<boolean> {
  const overrideContent = `[Service]\nEnvironment="OLLAMA_HOST=${bindAddress}"\n`;
  const result = await host.withElevation(
    `mkdir -p '${OVERRIDE_DIR}'` +
    ` && printf '%s' '${overrideContent}' > '${OVERRIDE_PATH}'` +
    ` && systemctl daemon-reload` +
    ` && systemctl restart ollama`,
    "Configure ollama bind address",
  );
  if (result.success) {
    pass("Ollama", `Listening on ${bindAddress}`);
    return true;
  }
  if (!result.skipped) {
    fail("Ollama", result.output || "Failed to configure bind address");
  }
  return false;
}

async function configureBindAddress(host: Host, dryRun: boolean): Promise<void> {
  const current = await getCurrentBindAddress(host);

  const portInput = await p.text({
    message: "Ollama port",
    placeholder: DEFAULT_PORT,
    defaultValue: DEFAULT_PORT,
  });
  if (p.isCancel(portInput)) return;

  const bindAddress = `0.0.0.0:${portInput}`;

  if (current === bindAddress) {
    info("Ollama", `Already configured to listen on ${bindAddress}`);
    return;
  }

  if (dryRun) {
    info("Dry run", `Would set OLLAMA_HOST=${bindAddress} via systemd override`);
    return;
  }

  await applyBindAddress(host, bindAddress);
}

/**
 * Ensure ollama listens on all interfaces. Called automatically after
 * install so remote nodes can reach this instance.
 */
async function ensurePublicBinding(host: Host, dryRun: boolean): Promise<void> {
  const current = await getCurrentBindAddress(host);
  if (current && current.startsWith("0.0.0.0:")) {
    pass("Ollama", `Listening on ${current}`);
    return;
  }

  info("Ollama", "Ollama defaults to localhost only, which is unreachable from other nodes.");
  const bind = await p.confirm({
    message: "Make ollama accessible on the network (0.0.0.0:11434)?",
    initialValue: true,
  });
  if (p.isCancel(bind) || !bind) return;

  if (dryRun) {
    info("Dry run", `Would set OLLAMA_HOST=0.0.0.0:${DEFAULT_PORT} via systemd override`);
    return;
  }

  await applyBindAddress(host, `0.0.0.0:${DEFAULT_PORT}`);
}

// ─── End-to-end: test endpoint + write daemon env ───────────────────────────

/**
 * Resolve the ollama endpoint URL reachable from the network.
 * Uses the bind address port from the systemd override, combined with the
 * host's LAN IP (since 0.0.0.0 isn't a routable address).
 */
async function resolveEndpointUrl(host: Host): Promise<string> {
  const current = await getCurrentBindAddress(host);
  const port = current?.split(":")[1] ?? DEFAULT_PORT;

  // Get the host's network-facing IP
  const result = await host.runShell(
    `hostname -I 2>/dev/null | awk '{print $1}' || echo 127.0.0.1`,
  );
  const ip = result.ok ? result.output.trim() : "127.0.0.1";
  return `http://${ip}:${port}`;
}

async function testEndpoint(url: string, host: Host): Promise<boolean> {
  // Test from the host itself (the gateway/daemon will reach it over the network)
  const result = await host.runShell(`curl -sf --connect-timeout 5 '${url}/api/tags' > /dev/null`);
  return result.ok;
}

/**
 * Write XINITY_OLLAMA_ENDPOINT into the daemon's env file.
 * Reads the existing file, adds/updates the key, and writes it back.
 */
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
 * After ollama is installed and bound, verify the endpoint is reachable
 * and persist the endpoint URL into the daemon's env file.
 */
async function finalizeSetup(host: Host, dryRun: boolean): Promise<void> {
  const endpoint = await resolveEndpointUrl(host);

  if (dryRun) {
    info("Dry run", `Would test endpoint ${endpoint} and write to daemon.env`);
    return;
  }

  const ok = await testEndpoint(endpoint, host);
  if (ok) {
    pass("Ollama", `Endpoint reachable at ${endpoint}`);
  } else {
    warn("Ollama", `Endpoint not reachable at ${endpoint}. The daemon may not be able to connect.`);
    const proceed = await p.confirm({
      message: "Save this endpoint anyway?",
      initialValue: true,
    });
    if (p.isCancel(proceed) || !proceed) return;
  }

  await writeDaemonEndpoint(host, endpoint);
}

// ─── Main entry point ───────────────────────────────────────────────────────

export async function ollamaSetup(host: Host, dryRun: boolean): Promise<void> {
  p.log.step(pc.bold("Ollama setup"));

  const installed = await isOllamaInstalled(host);

  if (installed) {
    const version = await getOllamaVersion(host);
    pass("Ollama", `Installed${version ? ` (v${version.replace(/^v/, "")})` : ""}`);

    const running = await isOllamaRunning(host);

    if (running) {
      pass("Ollama", "Service is running");

      const action = await p.select({
        message: "Ollama is installed and running.",
        options: [
          { value: "keep", label: "Keep current setup" },
          { value: "update", label: "Update ollama to latest version" },
          { value: "configure", label: "Configure bind address and port" },
        ],
      });
      if (p.isCancel(action) || action === "keep") return;

      if (action === "update") {
        if (dryRun) {
          info("Dry run", "Would update ollama");
          return;
        }
        await installOrUpdateOllama(host);
        await ensurePublicBinding(host, dryRun);
        await finalizeSetup(host, dryRun);
        return;
      }

      if (action === "configure") {
        await configureBindAddress(host, dryRun);
        await finalizeSetup(host, dryRun);
        return;
      }
    } else {
      warn("Ollama", "Installed but service is not running");

      const action = await p.select({
        message: "Ollama service is not running.",
        options: [
          { value: "start", label: "Start the service" },
          { value: "update", label: "Update and start" },
        ],
      });
      if (p.isCancel(action)) return;

      if (dryRun) {
        info("Dry run", `Would ${action} ollama`);
        return;
      }

      if (action === "update") {
        await installOrUpdateOllama(host);
      } else {
        await startOllamaService(host);
      }
      await ensurePublicBinding(host, dryRun);
      await finalizeSetup(host, dryRun);
      return;
    }
  } else {
    info("Ollama", "Not found on this system");

    const action = await p.select({
      message: "Ollama is not installed.",
      options: [
        { value: "install", label: "Install ollama", hint: "uses official install script" },
        { value: "skip", label: "Skip" },
      ],
    });
    if (p.isCancel(action) || action === "skip") return;

    if (dryRun) {
      info("Dry run", "Would install ollama: curl -fsSL https://ollama.com/install.sh | sh");
      return;
    }

    await installOrUpdateOllama(host);
    await ensurePublicBinding(host, dryRun);
    await finalizeSetup(host, dryRun);
  }
}
