/**
 * Component installer: the apply half of the up flow. Executes decisions
 * already made and reviewed during planning (up-plan.ts); nothing prompts.
 */
import { log, note, spinner } from "./clack.ts";
import { bold, cyan, yellow } from "picocolors";

import { fetchRelease, type Release } from "./github.ts";
import { buildLocalArtifact } from "./local-build.ts";
import { readManifest, updateManifestEntry } from "./manifest.ts";
import { unitName } from "./systemd.ts";
import { parseEnvString } from "./env-file.ts";
import { pass, fail, warn, info } from "./output.ts";
import { type Host, commandExistsOn, isUnitActiveOn } from "./host.ts";
import { isOllamaRunning } from "./ollama-setup.ts";
import { heredoc, writeEnvConfig, writeSystemdUnit, stopService, startService, restartService } from "./service.ts";
import { runSteps, createProgress, type Progress } from "./step-runner.ts";
import {
  type Component, type InstallResult,
  ENV_DIR, SECRETS_DIR, BIN_DIR, UNIT_DIR,
  binaryBaseName,
} from "./component-meta.ts";
import type { ComponentAction } from "./up-plan.ts";
// @ts-expect-error Bun text import
import vllmTemplateUnit from "xinity-ai-daemon/src/assets/vllm-driver@.service" with { type: "text" };

import { installBinary, downloadAndVerifyOnHost } from "./install-download.ts";
import type { EnvBundle } from "./env-prompt.ts";

export type ServiceFailurePolicy = "rollback" | "keep";

// ─── Pre-checks ────────────────────────────────────────────────────────────

export type PreflightIssue = {
  tool: string;
  reason: string;
  hint?: string;
}

/**
 * Check all tool requirements upfront for the given components.
 * Returns a list of missing tools with install hints.
 * Deduplicates across components so each tool is only reported once.
 */
export async function preflightCheck(
  components: readonly string[],
  host: Host,
): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = [];
  const checked = new Set<string>();

  const check = async (tool: string, reason: string, hint?: string) => {
    if (checked.has(tool)) return;
    checked.add(tool);
    if (!(await commandExistsOn(host, tool))) {
      issues.push({ tool, reason, hint });
    }
  };

  // systemd is required for any service component
  const serviceComponents: string[] = ["gateway", "dashboard", "daemon", "infoserver", "tether"];
  if (components.some((c) => serviceComponents.includes(c) || c === "all")) {
    await check("systemctl", "systemd is required to manage services");
  }

  const needsExtractor = components.some(
    (c) => c === "all" || serviceComponents.includes(c),
  );
  if (needsExtractor) {
    await check("tar", "required on the target host for binary extraction", "apt install tar / dnf install tar / pacman -S tar");
  }

  if (components.some((c) => serviceComponents.includes(c) || c === "all" || c === "db")) {
    await check("curl", "required on the target host for downloading release assets");
  }

  return issues;
}

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

// ─── Version resolution (planning phase, read-only) ────────────────────────

export type VersionResult =
  | { status: "proceed"; release: Release; isUpdate: boolean; installedVersion?: string }
  | { status: "current"; version: string }
  | { status: "failed" };

export async function resolveVersion(
  component: Component,
  targetVersion: string,
  host: Host,
): Promise<VersionResult> {
  let release: Release;
  try {
    release = await fetchRelease(targetVersion);
  } catch (err) {
    fail("GitHub API", (err as Error).message);
    return { status: "failed" };
  }

  const manifest = await readManifest(host);
  const installedEntry = manifest.components[component];
  const installedVersion = installedEntry?.version;
  const isUpdate = !!installedVersion;

  if (installedVersion === release.tagName) {
    // Verify the installed binary is intact before deciding.
    if (installedEntry?.binaryChecksum && installedEntry.binaryPath) {
      const checksumSpinner = spinner();
      checksumSpinner.start(`Verifying installed ${component} binary…`);
      const currentHash = await host.computeSha256(installedEntry.binaryPath);
      if (currentHash === installedEntry.binaryChecksum) {
        checksumSpinner.stop(`${component} ${release.tagName} installed and verified`);
        return { status: "current", version: release.tagName };
      }
      checksumSpinner.stop(`${component}: checksum mismatch, binary may be corrupted. Reinstalling`);
      return { status: "proceed", release, isUpdate: true, installedVersion };
    }

    // No stored checksum (legacy install): treat as current.
    info("Version", `${component} already installed (no checksum recorded to verify)`);
    return { status: "current", version: release.tagName };
  }

  if (isUpdate) {
    info("Version", `${component}: update available ${installedVersion} → ${release.tagName}`);
  }
  return { status: "proceed", release, isUpdate, installedVersion };
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

/** Move the current binary aside to <path>.bak before installing the new one. */
async function backupCurrentBinary(component: Component, host: Host, progress: Progress): Promise<void> {
  const binPath = `${BIN_DIR}/${binaryBaseName(component)}`;
  const result = await host.withElevation(
    `[ -f ${binPath} ] && mv -f ${binPath} ${binPath}.bak || true`,
    `Back up ${component} binary`,
  );
  if (result.success) progress.update(`Previous binary saved to ${binPath}.bak`);
}

/** Copy the current env file and secrets aside to .bak before reconfiguring. */
async function backupCurrentConfig(component: Component, host: Host, progress: Progress): Promise<void> {
  const envPath = `${ENV_DIR}/${component}.env`;
  const result = await host.withElevation(
    [
      `[ -f ${envPath} ] && cp -p ${envPath} ${envPath}.bak || true`,
      `[ -d ${SECRETS_DIR} ] && cp -ap ${SECRETS_DIR} ${SECRETS_DIR}.bak 2>/dev/null || true`,
    ].join(" && "),
    `Back up ${component} configuration`,
  );
  if (result.success) progress.update(`Previous configuration saved to ${envPath}.bak`);
}

async function bringServiceUp(component: Component, host: Host, progress: Progress): Promise<boolean> {
  return (await isUnitActiveOn(host, unitName(component)))
    ? runSteps(restartService(component, host), progress)
    : runSteps(startService(component, host), progress);
}

/** Restore the .bak binary and configuration, then bring the service back up. */
async function performRollback(component: Component, host: Host, progress: Progress, restoreBinary = true): Promise<void> {
  const binPath = `${BIN_DIR}/${binaryBaseName(component)}`;
  const envPath = `${ENV_DIR}/${component}.env`;
  const unit = unitName(component);

  info("Rollback", restoreBinary ? "Restoring previous version…" : "Restoring previous configuration…");
  if (restoreBinary) {
    await host.withElevation(
      `[ -f ${binPath}.bak ] && cp -p ${binPath}.bak ${binPath} && chmod +x ${binPath} || true`,
      `Restore ${component} binary`,
    );
  }
  await host.withElevation(
    [
      `[ -f ${envPath}.bak ] && cp -p ${envPath}.bak ${envPath} || true`,
      `[ -d ${SECRETS_DIR}.bak ] && cp -ap ${SECRETS_DIR}.bak/. ${SECRETS_DIR}/ 2>/dev/null || true`,
    ].join(" && "),
    `Restore ${component} configuration`,
  );
  pass("Rollback", restoreBinary ? "Previous binary and configuration restored" : "Previous configuration restored");

  if (await bringServiceUp(component, host, progress)) {
    pass("Rollback", restoreBinary ? `${unit} is back on the previous version` : `${unit} restarted with previous configuration`);
  } else {
    warn("Rollback", "Service did not restart after rollback. Manual intervention may be needed");
    log.info(`  ${cyan(`systemctl start ${unit}`)}`);
  }
}

/**
 * Write env config and systemd unit, then bring the service up. On failure
 * the outcome follows the failure policy: roll back to the .bak backups
 * (updates only) or keep the broken state for manual diagnosis.
 * Returns accumulated non-fatal errors.
 */
async function applyConfigAndStart(
  component: Component,
  env: EnvBundle,
  host: Host,
  isUpdate: boolean,
  onFailure: ServiceFailurePolicy,
  progress: Progress,
  binaryChanged = true,
): Promise<string[]> {
  const errors: string[] = [];
  const unit = unitName(component);

  progress.update("Writing configuration…");
  const configResult = await writeEnvConfig(component, env.config, env.secrets, host);
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

  if (isUpdate && onFailure === "rollback") {
    await performRollback(component, host, progress, binaryChanged);
    errors.push(binaryChanged
      ? "Service failed to start; rolled back to the previous version"
      : "Service failed to start; rolled back to the previous configuration");
    return errors;
  }

  if (!isUpdate) {
    // Disable the broken unit so it doesn't start on boot.
    await host.withElevation(
      `systemctl disable --now ${unit} 2>/dev/null; systemctl reset-failed ${unit} 2>/dev/null`,
      `Disable ${unit}`,
    );
  }
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
  onFailure: ServiceFailurePolicy = "rollback",
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
  let versionString = action.toVersion;
  const progress = externalProgress ?? createProgress(`${component}: preparing…`);

  try {
    if (isUpdate) {
      await backupCurrentConfig(component, host, progress);
    }

    if (action.kind !== "reconfigure") {
      if (isUpdate) {
        await backupCurrentBinary(component, host, progress);

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

      let archivePath: string;
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

      const installed = await runSteps(installBinary(component, archivePath, host), progress);
      if (!installed) return { success: false, version: versionString, errors: ["Installation failed or skipped"] };
    }

    const binaryChanged = action.kind !== "reconfigure";
    const errors = await applyConfigAndStart(component, action.env, host, isUpdate, onFailure, progress, binaryChanged);

    const success = errors.length === 0;

    if (action.kind !== "reconfigure") {
      const binaryPath = `${BIN_DIR}/${binaryBaseName(component)}`;
      const binaryChecksum = (await host.computeSha256(binaryPath)) ?? undefined;
      await updateManifestEntry(component, {
        version: success ? versionString : (action.installedVersion ?? versionString),
        installedAt: new Date().toISOString(),
        binaryPath,
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

/** Show onboarding hints after a dashboard install. */
export async function showDashboardHints(host: Host): Promise<void> {
  const dashContent = await host.readFile(`${ENV_DIR}/dashboard.env`);
  const origin = dashContent ? parseEnvString(dashContent).ORIGIN : undefined;

  const lines: string[] = [];
  if (origin) {
    lines.push(`Dashboard:  ${cyan(origin)}`);
    lines.push("");
    lines.push(bold("Next steps:"));
    lines.push(`  1. Connect the CLI to your dashboard:`);
    lines.push(`     ${cyan(`xinity configure dashboardUrl ${origin}`)}`);
    lines.push(`  2. Create your admin account from the CLI:`);
    lines.push(`     ${cyan("xinity act onboarding.cli")}`);
    lines.push(`     Or open ${cyan(origin)} in a browser to sign up there.`);
  } else {
    lines.push(bold("Next steps:"));
    lines.push(`  1. Create your admin account via the dashboard UI`);
    lines.push(`     Or from the CLI: ${cyan("xinity act onboarding.cli")}`);
  }

  note(lines.join("\n"), "Dashboard installed");
}
