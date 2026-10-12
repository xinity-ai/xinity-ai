/**
 * Component installer: the apply half of the up flow. Executes decisions
 * already made and reviewed during planning (up-plan.ts); nothing prompts.
 */
import { log } from "../core/clack.ts";
import { cyan, yellow } from "picocolors";

import { buildLocalArtifact } from "./local-build.ts";
import { updateManifestEntry } from "./manifest.ts";
import { unitName } from "./systemd.ts";
import { pass, warn, info } from "../core/output.ts";
import { type Host, commandExistsOn, isUnitActiveOn } from "../core/host.ts";
import { isOllamaRunning } from "../infra/ollama-setup.ts";
import { heredoc, writeEnvConfig, writeSystemdUnit, stopService, startService, restartService } from "./service.ts";
import { runSteps, createProgress, type Progress } from "../term/step-runner.ts";
import {
  type Component, type InstallResult,
  ENV_DIR, SECRETS_DIR, BIN_DIR, UNIT_DIR,
  binaryBaseName,
} from "../core/component-meta.ts";
import type { ComponentAction } from "./up-plan.ts";
// @ts-expect-error Bun text import
import vllmTemplateUnit from "xinity-ai-daemon/src/assets/vllm-driver@.service" with { type: "text" };

import { installBinary, downloadAndVerifyOnHost } from "./install-download.ts";
import type { EnvBundle } from "../config/env-prompt.ts";

// ─── vLLM systemd template install ─────────────────────────────────────────

async function installVllmTemplate(host: Host, templatePath: string, progress: Progress): Promise<void> {
  const exists = await host.fileExists(templatePath);
  if (exists) {
    progress.update(`vLLM template already installed at ${templatePath}`);
    return;
  }

  const result = await host.withElevation(
    `cat > ${templatePath} ${heredoc("VLLMEOF", vllmTemplateUnit)}\nsystemctl daemon-reload`,
    "Install vLLM systemd template unit",
  );

  if (result.success) {
    progress.update(`vLLM template installed at ${templatePath}`);
  } else {
    progress.warn("vLLM template", `Failed to install: ${result.output}`);
  }
}

// ─── Driver tool checks (daemon only) ───────────────────────────────────────

async function startOllama(host: Host, progress: Progress): Promise<void> {
  const result = await host.withElevation(
    "systemctl enable --now ollama",
    "Start ollama service",
  );
  if (result.success) {
    progress.update("ollama service started");
  } else {
    progress.warn("Ollama", `Failed to start ollama: ${result.output}`);
  }
}

/**
 * Checks the tools each driver needs. Ollama takes no configuration, so it
 * counts as a driver whenever its binary is on the host; a stopped service is
 * started. vLLM stays derived from the configured env values.
 */
async function checkDriverTools(
  config: Record<string, string>,
  secrets: Record<string, string>,
  host: Host,
  progress: Progress,
): Promise<void> {
  const all = { ...config, ...secrets };
  const ollamaInstalled = await commandExistsOn(host, "ollama");
  const vllmDockerEnabled = !!all.VLLM_DOCKER_IMAGE;
  const vllmSystemdEnabled = !!all.VLLM_PATH;
  const vllmEnabled = vllmDockerEnabled || vllmSystemdEnabled;

  const drivers: string[] = [];
  if (ollamaInstalled) drivers.push("ollama");
  if (vllmEnabled) drivers.push("vllm");

  if (drivers.length === 0) {
    progress.warn(
      "Drivers",
      `No drivers detected. Install ollama with ${cyan("xinity up infra-ollama")}, or set VLLM_DOCKER_IMAGE or VLLM_PATH`,
      "  Or install ollama manually: curl -fsSL https://ollama.com/install.sh | sh",
    );
    return;
  }

  progress.update(`Checking drivers: ${drivers.join(", ")}`);

  // ── Ollama ──
  if (ollamaInstalled) {
    if (await isOllamaRunning(host)) {
      progress.update("ollama service is running");
    } else {
      progress.update("ollama service is not running, starting it");
      await startOllama(host, progress);
    }
  }

  // ── vLLM (Docker) ──
  if (vllmDockerEnabled) {
    const hasDocker = await commandExistsOn(host, "docker");
    if (hasDocker) {
      progress.update("docker found (vllm-docker mode)");

      // Check for GPU container runtime matching the detected GPU vendor
      const hasNvidiaSmi = await commandExistsOn(host, "nvidia-smi");
      if (hasNvidiaSmi) {
        const rtResult = await host.run(["nvidia-container-runtime", "--version"]);
        if (rtResult.ok) {
          progress.update("NVIDIA container runtime detected");
        } else {
          progress.warn(
            "vLLM",
            "NVIDIA container runtime not found, GPU passthrough may not work",
            "  Install nvidia-container-toolkit: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html",
          );
        }
      } else if (await commandExistsOn(host, "rocm-smi")) {
        progress.update("AMD GPU detected (ROCm)");
      } else {
        progress.warn("vLLM", "No GPU tools detected (nvidia-smi / rocm-smi), GPU passthrough may not work");
      }
    } else {
      progress.warn(
        "vLLM",
        "docker not found but VLLM_DOCKER_IMAGE is set",
        "  Install Docker: https://docs.docker.com/engine/install/",
      );
    }
  }

  // ── vLLM (Systemd) ──
  if (vllmSystemdEnabled) {
    const vllmPath = all.VLLM_PATH!;
    const exists = await host.fileExists(vllmPath);
    if (exists) {
      progress.update(`vllm binary found at ${vllmPath}`);
    } else {
      progress.warn("vLLM", `vllm binary not found at ${vllmPath}`, "  Ensure vLLM is installed: pip install vllm");
    }

    const templatePath = all.VLLM_TEMPLATE_UNIT_PATH ?? `${UNIT_DIR}/vllm-driver@.service`;
    await installVllmTemplate(host, templatePath, progress);
  }
}

// ─── Apply ──────────────────────────────────────────────────────────────────

async function buildAndUploadLocalArtifact(
  component: Component,
  repoPath: string,
  host: Host,
  progress: Progress,
): Promise<{ archivePath: string; version: string } | null> {
  const hostArch = await host.getArch();
  const buildResult = await runSteps(buildLocalArtifact(component, repoPath, hostArch as "x64" | "arm64"), progress);
  if (!buildResult) return null;

  const remoteTmp = `/tmp/xinity-local-${Date.now()}.tar.gz`;
  progress.update("Uploading artifact…");
  let effectivePath: string;
  try {
    effectivePath = await host.uploadFile(buildResult.archivePath, remoteTmp);
  } catch (err) {
    progress.fail("Upload", (err as Error).message);
    return null;
  }

  const hostHash = await host.computeSha256(effectivePath);
  if (hostHash && hostHash !== buildResult.sha256) {
    progress.fail("Verify", `Checksum mismatch after upload (local: ${buildResult.sha256}, host: ${hostHash})`);
    return null;
  }
  progress.update("Upload checksum matched");
  return { archivePath: effectivePath, version: buildResult.version };
}

async function uploadPrebuiltArtifact(
  localPath: string,
  host: Host,
  progress: Progress,
): Promise<string | null> {
  const remoteTmp = `/tmp/xinity-local-${Date.now()}.tar.gz`;
  progress.update("Uploading pre-built artifact…");
  try {
    return await host.uploadFile(localPath, remoteTmp);
  } catch (err) {
    progress.fail("Upload", (err as Error).message);
    return null;
  }
}

function printServiceFailureDiagnostics(unit: string): void {
  log.warn(yellow("Service failed to start. Diagnostic commands:"));
  log.info(`  ${cyan(`systemctl status ${unit}`)}`);
  log.info(`  ${cyan(`journalctl -u ${unit} -e --no-pager`)}`);
}

function binaryPath(component: Component): string {
  return `${BIN_DIR}/${binaryBaseName(component)}`;
}

type Backup = { restore(): Promise<void> };

/**
 * Copies the component's env file, the shared secrets directory and, when the
 * binary is about to be replaced, the binary to <path>.bak. A path that does
 * not exist leaves no .bak, so restore never brings back an older backup.
 */
async function backUpInstallation(
  component: Component,
  includeBinary: boolean,
  host: Host,
  progress: Progress,
): Promise<Backup> {
  const paths = [`${ENV_DIR}/${component}.env`, SECRETS_DIR, ...(includeBinary ? [binaryPath(component)] : [])];
  const result = await host.withElevation(
    paths.map((path) => `rm -rf ${path}.bak && if [ -e ${path} ]; then cp -a ${path} ${path}.bak; fi`).join("\n"),
    `Back up ${component}`,
  );
  if (result.success) {
    progress.update(`Previous ${includeBinary ? "binary and configuration" : "configuration"} saved to .bak`);
  }
  return {
    restore: async () => {
      await host.withElevation(
        paths.map((path) => `if [ -e ${path}.bak ]; then rm -rf ${path} && cp -a ${path}.bak ${path}; fi`).join("\n"),
        `Restore ${component}`,
      );
    },
  };
}

async function bringServiceUp(component: Component, host: Host, progress: Progress): Promise<boolean> {
  return (await isUnitActiveOn(host, unitName(component)))
    ? runSteps(restartService(component, host), progress)
    : runSteps(startService(component, host), progress);
}

async function rollBack(component: Component, backup: Backup, binaryChanged: boolean, host: Host, progress: Progress): Promise<void> {
  const unit = unitName(component);

  info("Rollback", binaryChanged ? "Restoring previous version…" : "Restoring previous configuration…");
  await backup.restore();
  pass("Rollback", binaryChanged ? "Previous binary and configuration restored" : "Previous configuration restored");

  if (await bringServiceUp(component, host, progress)) {
    pass("Rollback", binaryChanged ? `${unit} is back on the previous version` : `${unit} restarted with previous configuration`);
  } else {
    warn("Rollback", "Service did not restart after rollback. Manual intervention may be needed");
    log.info(`  ${cyan(`systemctl start ${unit}`)}`);
  }
}

/**
 * Write env config and systemd unit, then bring the service up. A service
 * that does not start is rolled back when there is a backup, otherwise
 * disabled and left in place for manual diagnosis.
 * Returns accumulated non-fatal errors.
 */
async function applyConfigAndStart(
  component: Component,
  env: EnvBundle,
  removeSecretKeys: string[],
  backup: Backup | null,
  binaryChanged: boolean,
  host: Host,
  progress: Progress,
): Promise<string[]> {
  const errors: string[] = [];
  const unit = unitName(component);

  progress.update("Writing configuration…");
  const configResult = await writeEnvConfig(component, env.config, env.secrets, host, removeSecretKeys);
  if (configResult.success) {
    progress.update("Environment configured");
  } else {
    progress.fail("Config", configResult.error || "failed to write config");
    errors.push("Failed to write configuration (may need manual setup)");
  }

  if (component === "daemon") {
    await checkDriverTools(env.config, env.secrets, host, progress);
  }

  const secretKeys = Object.keys(env.secrets);
  const unitResult = await writeSystemdUnit(component, secretKeys, host);
  if (unitResult.success) {
    progress.update("Systemd unit installed");
  } else {
    progress.fail("Systemd", unitResult.error || "failed to install unit");
    errors.push("Systemd unit not installed (may need manual setup)");
  }

  if (await bringServiceUp(component, host, progress)) return errors;

  if (!progress.hasFailed()) {
    progress.fail("Service", `${unit} did not start successfully`);
  }
  printServiceFailureDiagnostics(unit);

  if (backup) {
    await rollBack(component, backup, binaryChanged, host, progress);
    errors.push(binaryChanged
      ? "Service failed to start; rolled back to the previous version"
      : "Service failed to start; rolled back to the previous configuration");
    return errors;
  }

  // Disable the broken unit so it doesn't start on boot.
  await host.withElevation(
    `systemctl disable --now ${unit} 2>/dev/null; systemctl reset-failed ${unit} 2>/dev/null`,
    `Disable ${unit}`,
  );
  errors.push("Service did not start successfully");
  return errors;
}

function actionSummary(action: ComponentAction, versionString: string): string {
  switch (action.kind) {
    case "install": return `${action.component} ${versionString} installed, service active`;
    case "update": return `${action.component} updated to ${versionString}, service active`;
    default: return `${action.component} reconfigured, service restarted`;
  }
}

/** Execute one reviewed component action from the plan. */
export async function applyComponentAction(
  action: ComponentAction,
  host: Host,
  externalProgress?: Progress,
): Promise<InstallResult> {
  const { component } = action;

  if (action.kind === "none") {
    if (!externalProgress) {
      pass("Skip", `${component} ${action.toVersion} is current, configuration unchanged`);
    }
    return { success: true, version: action.toVersion, errors: [] };
  }

  const isUpdate = action.kind !== "install";
  const binaryChanged = action.kind !== "reconfigure";
  let versionString = action.toVersion;
  const progress = externalProgress ?? createProgress(`${component}: preparing…`);

  try {
    let archivePath: string | null = null;
    if (binaryChanged) {
      if (action.localArchivePath) {
        const uploaded = await uploadPrebuiltArtifact(action.localArchivePath, host, progress);
        if (!uploaded) return { success: false, version: versionString, errors: ["Upload failed"] };
        archivePath = uploaded;
      } else if (action.localRepoPath) {
        const built = await buildAndUploadLocalArtifact(component, action.localRepoPath, host, progress);
        if (!built) return { success: false, version: versionString, errors: ["Local build failed"] };
        archivePath = built.archivePath;
        versionString = built.version;
      } else {
        const downloaded = await runSteps(downloadAndVerifyOnHost(action.release!, action.assetName!, host), progress);
        if (!downloaded) return { success: false, version: versionString, errors: ["Download failed"] };
        archivePath = downloaded;
      }
    }

    const backup = isUpdate ? await backUpInstallation(component, binaryChanged, host, progress) : null;

    if (archivePath) {
      if (isUpdate) {
        if (action.hardReset) {
          await stopService(component, host);
          const unit = unitName(component);
          progress.update(`Cleaning state for ${unit}…`);
          const result = await host.withElevation(
            `systemctl clean --what=state ${unit}`,
            `Clean state for ${unit}`,
          );
          if (result.success) {
            progress.update(`State cleaned for ${unit}`);
          } else {
            progress.warn("Hard reset", `Failed to clean state: ${result.output}`);
          }
        }
      }

      const installed = await runSteps(installBinary(component, archivePath, host), progress);
      if (!installed) {
        if (backup) {
          await backup.restore();
          if (action.hardReset && action.serviceRunning) {
            await runSteps(startService(component, host), progress);
          }
        }
        return { success: false, version: versionString, errors: ["Installation failed or skipped"] };
      }
    }

    const errors = await applyConfigAndStart(component, action.env, action.secretFiles.remove, backup, binaryChanged, host, progress);

    const success = errors.length === 0;

    if (binaryChanged) {
      const binaryChecksum = (await host.computeSha256(binaryPath(component))) ?? undefined;
      await updateManifestEntry(component, {
        version: success ? versionString : (action.installedVersion ?? versionString),
        installedAt: new Date().toISOString(),
        binaryPath: binaryPath(component),
        unitName: unitName(component),
        binaryChecksum,
      }, host);
    }
    if (success) {
      progress.done(actionSummary(action, versionString));
    }
    return { success, version: versionString, errors };
  } finally {
    progress.ensureSettled();
  }
}
