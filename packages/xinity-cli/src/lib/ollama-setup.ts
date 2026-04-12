/**
 * Interactive Ollama setup assistant for `xinity up infra-ollama`.
 *
 * Handles detection, installation, service management, and endpoint
 * configuration. The ollama endpoint is not a secret (just host:port),
 * so it is written into the daemon's env file rather than a secret file.
 */
import * as p from "./clack.ts";
import pc from "picocolors";
import { type Host, commandExistsOn, isUnitActiveOn } from "./host.ts";
import { pass, fail, info, warn } from "./output.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "11434";

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
  // Output is typically "ollama version is 0.6.2" or similar
  const match = result.output.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? result.output.trim();
}

// ─── Install / Update ───────────────────────────────────────────────────────

async function installOrUpdateOllama(host: Host): Promise<boolean> {
  const result = await host.withElevation(
    "curl -fsSL https://ollama.com/install.sh | sh",
    "Install/update ollama",
  );

  if (result.success) {
    pass("Ollama", "Installed successfully");

    // The install script usually starts the service. Give it a moment, then verify.
    await Bun.sleep(2000);
    if (!(await isOllamaRunning(host))) {
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

// ─── Endpoint configuration ─────────────────────────────────────────────────

async function configureEndpoint(): Promise<string> {
  const hostInput = await p.text({
    message: "Ollama host",
    placeholder: DEFAULT_HOST,
    defaultValue: DEFAULT_HOST,
  });
  if (p.isCancel(hostInput)) return `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

  const portInput = await p.text({
    message: "Ollama port",
    placeholder: DEFAULT_PORT,
    defaultValue: DEFAULT_PORT,
  });
  if (p.isCancel(portInput)) return `http://${hostInput}:${DEFAULT_PORT}`;

  return `http://${hostInput}:${portInput}`;
}

async function testEndpoint(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Main entry points ─────────────────────────────────────────────────────

/**
 * Full interactive Ollama setup for `xinity up infra-ollama`.
 */
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
          { value: "configure", label: "Configure endpoint" },
        ],
      });
      if (p.isCancel(action) || action === "keep") return;

      if (action === "update") {
        if (dryRun) {
          info("Dry run", "Would update ollama");
          return;
        }
        await installOrUpdateOllama(host);
        return;
      }

      if (action === "configure") {
        const endpoint = await configureEndpoint();
        const ok = await testEndpoint(endpoint);
        if (ok) {
          pass("Ollama", `Endpoint reachable: ${endpoint}`);
        } else {
          warn("Ollama", `Endpoint not reachable: ${endpoint}`);
        }
        p.note(endpoint, "XINITY_OLLAMA_ENDPOINT");
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
  }
}
