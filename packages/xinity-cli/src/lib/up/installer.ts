/**
 * Component installer: the apply half of the up flow. Executes decisions
 * already made and reviewed during planning (up-plan.ts); nothing prompts.
 */
import { basename } from "node:path";
import { cyan } from "picocolors";

import { buildLocalArtifact } from "./local-build.ts";
import { manifestWriteFailure, updateManifestEntry } from "./manifest.ts";
import { pass } from "../core/output.ts";
import { type Host, commandExistsOn, httpOk } from "../core/host.ts";
import type { HostOs } from "../core/platform.ts";
import { isServiceActiveOn, serviceManagerOf } from "./service-manager.ts";
import { isOllamaRunning } from "../infra/ollama-setup.ts";
import { heredoc, writeEnvConfig, writeServiceDefinition, stopService, startService, restartService } from "./service.ts";
import { runSteps, createProgress, type Progress } from "../term/step-runner.ts";
import {
  type Component, type InstallResult,
  ENV_DIR, SECRETS_DIR, BIN_DIR, UNIT_DIR, DEFAULT_OLLAMA_URL,
  binaryBaseName,
} from "../core/component-meta.ts";
import type { ComponentAction, ComponentActionKind } from "./up-plan.ts";
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
async function checkLinuxDriverTools(
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

// On macOS Ollama is an app the user installs and runs, and vLLM is not available.
async function checkMacDriverTools(
  config: Record<string, string>,
  _secrets: Record<string, string>,
  host: Host,
  progress: Progress,
): Promise<void> {
  const ollamaUrl = config.OLLAMA_URL || DEFAULT_OLLAMA_URL;
  if (await httpOk(host, `${ollamaUrl}/api/version`)) {
    progress.update(`ollama answers at ${ollamaUrl}`);
    return;
  }
  progress.warn(
    "Drivers",
    `Ollama does not answer at ${ollamaUrl}, so the node will offer no driver`,
    "  Install and start Ollama for macOS: https://ollama.com/download/mac",
  );
}

const DRIVER_CHECKS: Record<HostOs, typeof checkLinuxDriverTools> = {
  linux: checkLinuxDriverTools,
  darwin: checkMacDriverTools,
};

// ─── Apply ──────────────────────────────────────────────────────────────────

type ApplyableKind = Exclude<ComponentActionKind, "none">;

const KIND_BEHAVIOUR: Record<ApplyableKind, {
  replacesBinary: boolean;
  backsUp: boolean;
  summary: (component: Component, version: string) => string;
}> = {
  install: {
    replacesBinary: true,
    backsUp: false,
    summary: (component, version) => `${component} ${version} installed, service active`,
  },
  update: {
    replacesBinary: true,
    backsUp: true,
    summary: (component, version) => `${component} updated to ${version}, service active`,
  },
  reconfigure: {
    replacesBinary: false,
    backsUp: true,
    summary: (component) => `${component} reconfigured, service restarted`,
  },
};

function binaryPath(component: Component): string {
  return `${BIN_DIR}/${binaryBaseName(component)}`;
}

type Artifact = { archivePath: string; version: string };

async function uploadArtifact(localPath: string, host: Host, progress: Progress): Promise<string | null> {
  progress.update("Uploading artifact…");
  try {
    return await host.uploadFile(localPath, `/tmp/xinity-local-${Date.now()}.tar.gz`);
  } catch (err) {
    progress.fail("Upload", (err as Error).message);
    return null;
  }
}

async function buildAndUploadLocalArtifact(
  component: Component,
  repoPath: string,
  host: Host,
  progress: Progress,
): Promise<Artifact | null> {
  const hostArch = await host.getArch();
  const buildResult = await runSteps(buildLocalArtifact(component, repoPath, host.os, hostArch), progress);
  if (!buildResult) return null;

  const archivePath = await uploadArtifact(buildResult.archivePath, host, progress);
  if (!archivePath) return null;

  const hostHash = await host.computeSha256(archivePath);
  if (hostHash && hostHash !== buildResult.sha256) {
    progress.fail("Verify", `Checksum mismatch after upload (local: ${buildResult.sha256}, host: ${hostHash})`);
    return null;
  }
  progress.update("Upload checksum matched");
  return { archivePath, version: buildResult.version };
}

async function obtainArtifact(action: ComponentAction, host: Host, progress: Progress): Promise<Artifact | { error: string }> {
  if (action.localArchivePath) {
    const archivePath = await uploadArtifact(action.localArchivePath, host, progress);
    return archivePath ? { archivePath, version: action.toVersion } : { error: "Upload failed" };
  }
  if (action.localRepoPath) {
    const built = await buildAndUploadLocalArtifact(action.component, action.localRepoPath, host, progress);
    return built ?? { error: "Local build failed" };
  }
  const archivePath = await runSteps(downloadAndVerifyOnHost(action.release!, action.assetName!, host), progress);
  return archivePath ? { archivePath, version: action.toVersion } : { error: "Download failed" };
}

type Backup = { includesBinary: boolean; restore(): Promise<boolean> };

/**
 * Copies the component's env file, the shared secrets directory, its service
 * definition and, when the binary is about to be replaced, the binary to a
 * .bak copy. A path that does not exist leaves no .bak, so restore never
 * brings back an older backup.
 */
async function backUpInstallation(
  component: Component,
  includesBinary: boolean,
  host: Host,
  progress: Progress,
): Promise<Backup> {
  const manager = serviceManagerOf(host);
  const definition = manager.definitionPath(component);
  // launchd loads every file in its directory, so the definition's copy lives with the config.
  const copies = [
    ...[`${ENV_DIR}/${component}.env`, SECRETS_DIR, ...(includesBinary ? [binaryPath(component)] : [])]
      .map((path) => ({ path, backup: `${path}.bak` })),
    { path: definition, backup: `${ENV_DIR}/${basename(definition)}.bak` },
  ];
  const result = await host.withElevation(
    copies.map(({ path, backup }) => `rm -rf ${backup} && if [ -e ${path} ]; then cp -a ${path} ${backup}; fi`).join("\n"),
    `Back up ${component}`,
  );
  if (result.success) {
    progress.update(`Previous ${includesBinary ? "binary and configuration" : "configuration"} saved to .bak`);
  }
  return {
    includesBinary,
    restore: async () => {
      const result = await host.withElevation(
        [
          ...copies.map(({ path, backup }) => `if [ -e ${backup} ]; then rm -rf ${path} && cp -a ${backup} ${path}; fi`),
          manager.afterDefinitionWrite(component),
        ].join("\n"),
        `Restore ${component}`,
      );
      return result.success;
    },
  };
}

async function hardResetService(component: Component, host: Host, progress: Progress): Promise<void> {
  const manager = serviceManagerOf(host);
  const unit = manager.serviceName(component);
  await stopService(component, host);
  progress.update(`Cleaning state for ${unit}…`);
  const result = await host.withElevation(manager.resetStateCommand(component), `Clean state for ${unit}`);
  if (result.success) {
    progress.update(`State cleaned for ${unit}`);
  } else {
    progress.warn("Hard reset", `Failed to clean state: ${result.output}`);
  }
}

async function bringServiceUp(component: Component, host: Host, progress: Progress): Promise<boolean> {
  return (await isServiceActiveOn(host, component))
    ? runSteps(restartService(component, host), progress)
    : runSteps(startService(component, host), progress);
}

/**
 * Write env config and the service definition, then bring the service up. A service
 * that does not start is rolled back when there is a backup, otherwise
 * disabled and left in place for manual diagnosis.
 * Returns accumulated non-fatal errors.
 */
async function applyConfigAndStart(
  component: Component,
  env: EnvBundle,
  removeSecretKeys: string[],
  backup: Backup | null,
  host: Host,
  progress: Progress,
): Promise<string[]> {
  const errors: string[] = [];
  const manager = serviceManagerOf(host);
  const unit = manager.serviceName(component);
  const definitionLabel = manager.definitionKind[0]!.toUpperCase() + manager.definitionKind.slice(1);

  progress.update("Writing configuration…");
  const configResult = await writeEnvConfig(component, env.config, env.secrets, host, removeSecretKeys);
  if (configResult.success) {
    progress.update("Environment configured");
  } else {
    progress.fail("Config", configResult.error || "failed to write config");
    errors.push("Failed to write configuration (may need manual setup)");
  }

  if (component === "daemon") {
    await DRIVER_CHECKS[host.os](env.config, env.secrets, host, progress);
  }

  const secretKeys = Object.keys(env.secrets);
  const definitionResult = await writeServiceDefinition(component, { config: env.config, secretKeys }, host);
  if (definitionResult.success) {
    progress.update(`${definitionLabel} installed`);
  } else {
    progress.fail(definitionLabel, definitionResult.error || `failed to install the ${manager.definitionKind}`);
    errors.push(`${definitionLabel} not installed (may need manual setup)`);
  }

  if (await bringServiceUp(component, host, progress)) return errors;

  if (!progress.hasFailed()) {
    progress.fail("Service", `${unit} did not start successfully`);
  }
  progress.update(`Diagnose with ${manager.diagnoseCommands(component).map((command) => cyan(command)).join(" and ")}`);

  if (backup) {
    const previous = backup.includesBinary ? "previous version" : "previous configuration";
    progress.update(`Restoring the ${previous}…`);
    if (await backup.restore()) {
      if (await bringServiceUp(component, host, progress)) {
        progress.update(`${unit} is back on the ${previous}`);
        errors.push(`Service failed to start; rolled back to the ${previous}`);
      } else {
        progress.warn("Rollback", `${unit} did not restart after restoring the ${previous}`, `  ${cyan(manager.startCommand(component))}`);
        errors.push(`Service failed to start; restored the ${previous}, but it did not restart either`);
      }
      return errors;
    }
    progress.fail("Rollback", `Could not restore the ${previous}`);
    errors.push(`Service failed to start, and restoring the ${previous} failed too`);
  }

  // Disable the broken service so it does not start on boot.
  await host.withElevation(`${manager.disableCommand(component)} 2>/dev/null`, `Disable ${unit}`);
  errors.push("Service did not start successfully");
  return errors;
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

  const behaviour = KIND_BEHAVIOUR[action.kind];
  const progress = externalProgress ?? createProgress(`${component}: preparing…`);

  try {
    let artifact: Artifact | null = null;
    if (behaviour.replacesBinary) {
      const obtained = await obtainArtifact(action, host, progress);
      if ("error" in obtained) return { success: false, version: action.toVersion, errors: [obtained.error] };
      artifact = obtained;
    }
    const version = artifact?.version ?? action.toVersion;

    const backup = behaviour.backsUp ? await backUpInstallation(component, behaviour.replacesBinary, host, progress) : null;

    if (artifact) {
      const hardReset = backup !== null && action.hardReset;
      if (hardReset) {
        await hardResetService(component, host, progress);
      }

      if (!(await runSteps(installBinary(component, artifact.archivePath, host), progress))) {
        const errors = ["Installation failed or skipped"];
        if (backup && !(await backup.restore())) {
          const previous = backup.includesBinary ? "previous version" : "previous configuration";
          progress.fail("Rollback", `Could not restore the ${previous}`);
          errors.push(`Restoring the ${previous} failed`);
        }
        if (hardReset && action.serviceRunning) {
          await runSteps(startService(component, host), progress);
        }
        return { success: false, version, errors };
      }
    }

    const errors = await applyConfigAndStart(component, action.env, action.secretFiles.remove, backup, host, progress);
    const started = errors.length === 0;

    if (artifact) {
      const recorded = await updateManifestEntry(component, {
        version: started ? version : (action.installedVersion ?? version),
        installedAt: new Date().toISOString(),
        binaryPath: binaryPath(component),
        unitName: serviceManagerOf(host).serviceName(component),
        binaryChecksum: (await host.computeSha256(binaryPath(component))) ?? undefined,
      }, host);
      if (!recorded) {
        const msg = manifestWriteFailure(host);
        progress.fail("Manifest", msg);
        errors.push(msg);
      }
    }
    const success = errors.length === 0;
    if (success) {
      progress.done(behaviour.summary(component, version));
    }
    return { success, version, errors };
  } finally {
    progress.ensureSettled();
  }
}
