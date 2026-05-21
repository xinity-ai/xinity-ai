/**
 * Top-level install/update orchestration for Xinity service components.
 *
 * Coordinates: pre-checks → version resolution → download → install binary →
 * env configuration → systemd unit → service start → health verify → manifest.
 */
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
import * as p from "./clack.ts";
import pc from "picocolors";

import { fetchRelease, downloadAsset, fetchChecksums, verifySha256, pickReleaseAsset, assetPrefix, resolveDirectUrl, type Release } from "./github.ts";
import { loadConfig } from "./config.ts";
import { buildLocalArtifact } from "./local-build.ts";
import { readManifest, updateManifestEntry, writeManifest } from "./manifest.ts";
import { generateUnit, getComponentConfig, unitName, type UnitConfig } from "./systemd.ts";
import { analyzeEnvSchema, categorizeFields, menuEditEnv, promptForEnv, splitValuesByCategory } from "./env-prompt.ts";
import { parseEnvString } from "./env-file.ts";
import { pass, fail, warn, info, cancelAndExit, elevationHardFailed, promptOrExit } from "./output.ts";
import { type Host, createLocalHost, commandExistsOn, isUnitActiveOn, readSecrets } from "./host.ts";
import { isOllamaRunning, waitForOllamaRunning } from "./ollama-setup.ts";
import { writeEnvConfig, writeSystemdUnit, stopService, startService } from "./service.ts";
import {
  type Component, type InstallResult, type RemoveResult,
  ENV_SCHEMAS, ENV_DIR, SECRETS_DIR, BIN_DIR, DASHBOARD_DIR, UNIT_DIR,
  binaryBaseName, getAutoDefaults,
} from "./component-meta.ts";
// @ts-ignore
import vllmTemplateUnit from "xinity-ai-daemon/src/assets/vllm-driver@.service" with { type: "text" };

export type { Release } from "./github.ts";

const DEFAULT_PROJECT_URL = "https://github.com/xinity-ai/xinity-ai";

function projectUrl(): string {
  return loadConfig().githubProjectUrl ?? DEFAULT_PROJECT_URL;
}

// ─── Pre-checks ────────────────────────────────────────────────────────────

interface PreflightIssue {
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
  const serviceComponents: string[] = ["gateway", "dashboard", "daemon", "infoserver"];
  if (components.some((c) => serviceComponents.includes(c) || c === "all")) {
    await check("systemctl", "systemd is required to manage services");
  }

  const needsExtractor = components.some(
    (c) => c === "all" || serviceComponents.includes(c),
  );
  if (needsExtractor) {
    const target = host.isRemote ? "the remote host" : "this machine";
    await check("tar", `required on ${target} for binary extraction`, "apt install tar / dnf install tar / pacman -S tar");
    // TODO drop unzip on v1.0.0
    await check("unzip", `required on ${target} to install pre-1.0.0 releases`, "apt install unzip / dnf install unzip / pacman -S unzip");
  }

  // curl is needed on remote hosts for downloading release assets
  if (host.isRemote && components.some((c) => serviceComponents.includes(c) || c === "all" || c === "db")) {
    await check("curl", "required on the remote host for downloading release assets");
  }

  return issues;
}

/** Legacy per-component pre-check, delegates to preflightCheck. */
async function preChecks(component: Component, host: Host): Promise<string[]> {
  const issues = await preflightCheck([component], host);
  return issues.map((i) => `${i.reason}${i.hint ? `. Install it: ${i.hint}` : ""}`);
}

// ─── vLLM systemd template install ─────────────────────────────────────────

async function installVllmTemplate(host: Host, templatePath: string): Promise<void> {
  const exists = await host.fileExists(templatePath);
  if (exists) {
    pass("vLLM template", `Already installed at ${templatePath}`);
    return;
  }

  const result = await host.withElevation(
    `cat > ${templatePath} << 'VLLMEOF'\n${vllmTemplateUnit}VLLMEOF\nsystemctl daemon-reload`,
    "Install vLLM systemd template unit",
  );

  reportElevationWarning(result, "vLLM template", `Installed at ${templatePath}`, "Failed to install");
}

// ─── Driver tool checks (daemon only) ───────────────────────────────────────

async function enableOllamaService(host: Host): Promise<void> {
  const result = await host.withElevation(
    "systemctl enable --now ollama",
    "Start ollama service",
  );
  reportElevationWarning(result, "Ollama", "ollama service started", "Failed to start ollama");
}

/**
 * Detects which drivers are enabled from the configured env values and ensures
 * the required tools are available. For ollama, offers automatic installation.
 */
async function ensureDriverTools(
  config: Record<string, string>,
  secrets: Record<string, string>,
  host: Host,
): Promise<void> {
  const all = { ...config, ...secrets };
  const ollamaEnabled = !!all.XINITY_OLLAMA_ENDPOINT;
  const vllmDockerEnabled = !!all.VLLM_DOCKER_IMAGE;
  const vllmSystemdEnabled = !!all.VLLM_PATH;
  const vllmEnabled = vllmDockerEnabled || vllmSystemdEnabled;

  const drivers: string[] = [];
  if (ollamaEnabled) drivers.push("ollama");
  if (vllmEnabled) drivers.push("vllm");

  if (drivers.length === 0) {
    warn("Drivers", "No drivers detected. Set XINITY_OLLAMA_ENDPOINT, VLLM_DOCKER_IMAGE, or VLLM_PATH to enable a driver");
    return;
  }

  info("Drivers", `Detected drivers: ${drivers.join(", ")}`);

  // ── Ollama ──
  if (ollamaEnabled) {
    const hasOllama = await commandExistsOn(host, "ollama");
    if (hasOllama) {
      pass("Ollama", "ollama binary found");

      // Check if ollama service is running
      if (await isOllamaRunning(host)) {
        pass("Ollama", "ollama service is running");
      } else {
        const startIt = await p.confirm({
          message: "Ollama is installed but the service is not running. Start it?",
          initialValue: true,
        });
        if (!p.isCancel(startIt) && startIt) {
          await enableOllamaService(host);
        }
      }
    } else {
      warn("Ollama", "ollama binary not found");
      const install = await p.confirm({
        message: "Ollama is not installed. Install it now?",
        initialValue: true,
      });

      if (!p.isCancel(install) && install) {
        const result = await host.withElevation(
          "curl -fsSL https://ollama.com/install.sh | sh",
          "Install ollama",
        );

        if (result.success) {
          pass("Ollama", "ollama installed successfully");

          // Poll until the service comes up (install script usually starts it)
          const ollamaSpinner = p.spinner();
          ollamaSpinner.start("Waiting for ollama service…");
          const ollamaRunning = await waitForOllamaRunning(host);
          ollamaSpinner.stop(ollamaRunning ? "Service running" : "Service not started automatically");

          if (!ollamaRunning) {
            await enableOllamaService(host);
          } else {
            pass("Ollama", "ollama service is running");
          }
        } else {
          warn("Ollama", `Automatic install failed: ${result.output}`);
          p.log.info(pc.dim("  Install manually: curl -fsSL https://ollama.com/install.sh | sh"));
        }
      }
    }
  }

  // ── vLLM (Docker) ──
  if (vllmDockerEnabled) {
    const hasDocker = await commandExistsOn(host, "docker");
    if (hasDocker) {
      pass("vLLM", "docker found (vllm-docker mode)");

      // Check for GPU container runtime matching the detected GPU vendor
      const hasNvidiaSmi = await commandExistsOn(host, "nvidia-smi");
      if (hasNvidiaSmi) {
        const rtResult = await host.run(["nvidia-container-runtime", "--version"]);
        if (rtResult.ok) {
          pass("vLLM", "NVIDIA container runtime detected");
        } else {
          warn("vLLM", "NVIDIA container runtime not found, GPU passthrough may not work");
          p.log.info(pc.dim("  Install nvidia-container-toolkit: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"));
        }
      } else if (await commandExistsOn(host, "rocm-smi")) {
        pass("vLLM", "AMD GPU detected (ROCm)");
      } else {
        warn("vLLM", "No GPU tools detected (nvidia-smi / rocm-smi), GPU passthrough may not work");
      }
    } else {
      warn("vLLM", "docker not found but VLLM_DOCKER_IMAGE is set");
      p.log.info(pc.dim("  Install Docker: https://docs.docker.com/engine/install/"));
    }
  }

  // ── vLLM (Systemd) ──
  if (vllmSystemdEnabled) {
    const vllmPath = all.VLLM_PATH!;
    const exists = await host.fileExists(vllmPath);
    if (exists) {
      pass("vLLM", `vllm binary found at ${vllmPath}`);
    } else {
      warn("vLLM", `vllm binary not found at ${vllmPath}`);
      p.log.info(pc.dim("  Ensure vLLM is installed: pip install vllm"));
    }

    const templatePath = all.VLLM_TEMPLATE_UNIT_PATH ?? `${UNIT_DIR}/vllm-driver@.service`;
    await installVllmTemplate(host, templatePath);
  }
}

// ─── Version resolution ────────────────────────────────────────────────────

type VersionResult =
  | { status: "proceed"; release: Release; isUpdate: boolean }
  | { status: "skipped"; version: string }
  | { status: "failed" };

async function resolveVersion(
  component: Component,
  targetVersion: string,
  host: Host,
): Promise<VersionResult> {
  const spinner = p.spinner();
  spinner.start("Checking for latest version…");

  let release: Release;
  try {
    release = await fetchRelease(targetVersion);
  } catch (err) {
    spinner.stop("Version check failed");
    fail("GitHub API", (err as Error).message);
    return { status: "failed" };
  }

  const manifest = await readManifest(host);
  const installedEntry = manifest.components[component];
  const installedVersion = installedEntry?.version;
  const isUpdate = !!installedVersion;

  if (installedVersion === release.tagName) {
    spinner.stop(`${release.tagName} already installed`);

    // Verify the installed binary is intact before deciding.
    if (installedEntry?.binaryChecksum && installedEntry.binaryPath) {
      const checksumSpinner = p.spinner();
      checksumSpinner.start("Verifying installed binary…");
      const currentHash = await host.computeSha256(installedEntry.binaryPath);
      if (currentHash === installedEntry.binaryChecksum) {
        checksumSpinner.stop("Already installed and verified, checksums match");
        return { status: "skipped", version: release.tagName };
      }
      checksumSpinner.stop("Checksum mismatch, binary may be corrupted. Reinstalling");
      warn("Checksum", "Installed binary does not match expected checksum");
      return { status: "proceed", release, isUpdate: true };
    }

    // No stored checksum (legacy install), prompt the user.
    const reinstall = await p.confirm({
      message: `${component} ${release.tagName} is already installed. Reinstall?`,
      initialValue: false,
    });
    if (p.isCancel(reinstall) || !reinstall) return { status: "skipped", version: release.tagName };
  } else if (isUpdate) {
    spinner.stop(`Update available: ${installedVersion} → ${release.tagName}`);
  } else {
    spinner.stop(`Latest version: ${release.tagName}`);
  }

  return { status: "proceed", release, isUpdate };
}

// ─── Download & verify ─────────────────────────────────────────────────────

function findReleaseAssetOrFail(release: Release, assetName: string): Release["assets"][number] | null {
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    fail("Download", `Asset ${assetName} not found in release ${release.tagName}`);
    return null;
  }
  return asset;
}

function assetSizeMb(asset: { size: number }): string {
  return (asset.size / 1024 / 1024).toFixed(1);
}

async function verifyReleaseChecksum(
  release: Release,
  assetName: string,
  filePath: string,
  verify: (path: string, expected: string) => Promise<boolean>,
  successLabel: string,
): Promise<boolean> {
  const checksumSpinner = p.spinner();
  checksumSpinner.start("Verifying checksum…");
  const checksums = await fetchChecksums(release);
  if (checksums.size === 0) {
    checksumSpinner.stop("No checksums available");
    warn("Checksum", "No SHASUMS256.txt found in release, skipping verification");
    return true;
  }
  const expected = checksums.get(assetName);
  if (!expected) {
    checksumSpinner.stop("No checksum entry");
    warn("Checksum", `No checksum entry for ${assetName} in SHASUMS256.txt, skipping verification`);
    return true;
  }
  const valid = await verify(filePath, expected);
  if (!valid) {
    checksumSpinner.stop("Verification failed");
    fail("Checksum", "SHA256 mismatch, the download may be corrupted");
    return false;
  }
  checksumSpinner.stop(successLabel);
  return true;
}

/**
 * Download a named release asset to `destDir`, verify its SHA256 checksum,
 * and return the local file path. Returns null on any failure.
 * Shared by installer, migrator, and self-update.
 */
export async function downloadAndVerify(
  release: Release,
  assetName: string,
  destDir: string,
): Promise<string | null> {
  const asset = findReleaseAssetOrFail(release, assetName);
  if (!asset) return null;

  const spinner = p.spinner();
  spinner.start(`Downloading ${assetName} (${assetSizeMb(asset)} MB)…`);

  let filePath: string;
  try {
    filePath = await downloadAsset(asset, destDir);
  } catch (err) {
    spinner.stop("Download failed");
    fail("Download", (err as Error).message);
    return null;
  }
  spinner.stop("Downloaded");

  const verified = await verifyReleaseChecksum(release, assetName, filePath, verifySha256, "Checksum verified");
  return verified ? filePath : null;
}

/**
 * Download a release asset directly on a remote host and verify its checksum.
 *
 * Resolves the GitHub download URL locally (where the auth token lives), then
 * tells the remote to `curl` it. Returns the remote file path, or null on failure.
 */
async function downloadAndVerifyOnHost(
  release: Release,
  assetName: string,
  host: Host,
): Promise<string | null> {
  const asset = findReleaseAssetOrFail(release, assetName);
  if (!asset) return null;

  // Resolve a direct URL locally (handles private repo auth + redirect)
  const urlSpinner = p.spinner();
  urlSpinner.start("Resolving download URL…");
  let directUrl: string;
  try {
    directUrl = await resolveDirectUrl(asset);
  } catch (err) {
    urlSpinner.stop("URL resolution failed");
    fail("Download", (err as Error).message);
    return null;
  }
  urlSpinner.stop("URL resolved");

  // Download on the remote host
  const remoteTmpDir = `/tmp/xinity-download-${Date.now()}`;
  const remotePath = `${remoteTmpDir}/${assetName}`;

  const dlSpinner = p.spinner();
  dlSpinner.start(`Downloading ${assetName} on remote host (${assetSizeMb(asset)} MB)…`);
  try {
    await host.run(["mkdir", "-p", remoteTmpDir]);
    await host.downloadFile(directUrl, remotePath);
  } catch (err) {
    dlSpinner.stop("Download failed");
    fail("Download", (err as Error).message);
    return null;
  }
  dlSpinner.stop("Downloaded on remote");

  const verified = await verifyReleaseChecksum(
    release, assetName, remotePath,
    (path, expected) => host.verifySha256(path, expected),
    "Checksum verified on remote",
  );
  return verified ? remotePath : null;
}

// ─── Install binary ────────────────────────────────────────────────────────

export function extractCommandArgv(archivePath: string, destDir: string): string[] {
  if (archivePath.endsWith(".tar.gz")) return ["tar", "-xzf", archivePath, "-C", destDir];
  if (archivePath.endsWith(".zip")) return ["unzip", "-o", archivePath, "-d", destDir];
  throw new Error(`Unsupported archive format: ${archivePath}`);
}

function extractCommand(archivePath: string, destDir: string): string {
  return extractCommandArgv(archivePath, destDir).join(" ");
}

function stripArchiveSuffix(path: string): string {
  return path.replace(/\.tar\.gz$|\.zip$/, "");
}

async function installBinary(component: Component, archivePath: string, host: Host): Promise<boolean> {
  const binName = binaryBaseName(component);

  if (host.isRemote) {
    // Archive already on remote, extract and install directly
    const tmpExtract = stripArchiveSuffix(archivePath);
    const result = await host.withElevation(
      `mkdir -p ${tmpExtract} && ${extractCommand(archivePath, tmpExtract)}` +
      ` && mkdir -p ${BIN_DIR} && rm -f ${BIN_DIR}/${binName}` +
      ` && cp ${tmpExtract}/${binName} ${BIN_DIR}/${binName}` +
      ` && chmod +x ${BIN_DIR}/${binName}` +
      ` && rm -rf ${tmpExtract} ${archivePath}`,
      `Install ${binName} binary`,
    );
    if (elevationHardFailed(result, "Install")) return false;
    if (result.skipped) return false;
  } else {
    // Local: extract locally, upload binary, place on host
    const tmpExtract = stripArchiveSuffix(archivePath);
    mkdirSync(tmpExtract, { recursive: true });

    const extractSpinner = p.spinner();
    extractSpinner.start("Extracting…");
    const local = createLocalHost();
    const extracted = await local.run(extractCommandArgv(archivePath, tmpExtract));
    if (!extracted.ok) {
      extractSpinner.stop("Extract failed");
      fail("Extract", extracted.output);
      return false;
    }

    const localBinPath = `${tmpExtract}/${binName}`;
    const remoteTmpPath = `/tmp/xinity-upload-${binName}`;
    let effectivePath: string;
    try {
      effectivePath = await host.uploadFile(localBinPath, remoteTmpPath);
    } catch (err) {
      extractSpinner.stop("Upload failed");
      fail("Upload", (err as Error).message);
      return false;
    }
    extractSpinner.stop("Extracted");

    const result = await host.withElevation(
      `mkdir -p ${BIN_DIR} && rm -f ${BIN_DIR}/${binName} && cp ${effectivePath} ${BIN_DIR}/${binName} && chmod +x ${BIN_DIR}/${binName}` +
        (effectivePath !== localBinPath ? ` && rm -f ${effectivePath}` : ""),
      `Install ${binName} binary`,
    );
    if (elevationHardFailed(result, "Install")) return false;
    if (result.skipped) return false;
  }

  // Best-effort cleanup of the legacy tarball installation directory
  if (component === "dashboard") {
    await host.withElevation(
      `rm -rf ${DASHBOARD_DIR} 2>/dev/null || true`,
      "Remove legacy dashboard directory",
    );
  }

  pass("Install", "Installed");
  return true;
}

// ─── Env configuration ─────────────────────────────────────────────────────

async function configureEnv(
  component: Component,
  host: Host,
  autoDefaults?: Record<string, string>,
): Promise<{ config: Record<string, string>; secrets: Record<string, string> } | null> {
  const schema = ENV_SCHEMAS[component];
  const fields = analyzeEnvSchema(schema);
  const { secretFields } = categorizeFields(fields);
  const secretKeys = secretFields.map((f) => f.key);

  // Load existing values from the host (auto-defaults < file config < file secrets)
  const envPath = `${ENV_DIR}/${component}.env`;
  const envContent = await host.readFile(envPath);
  const existingConfig = envContent ? parseEnvString(envContent) : {};
  let existingSecrets: Record<string, string> = {};
  // Track which secret keys should be treated as "already set" even if we
  // couldn't read their values. When elevation is skipped or denied, we
  // can't stat the files either (the secrets dir is root-only), so we
  // conservatively assume all secrets exist. Re-prompting for secrets the
  // user chose not to unlock would be worse than skipping a truly missing one.
  const secretsOnDisk = new Set<string>();
  let secretsLocked = false;
  if (secretKeys.length > 0) {
    const sr = await readSecrets(host, SECRETS_DIR, secretKeys, "Read existing secrets");
    existingSecrets = sr.secrets;
    if (sr.skipped || sr.permissionDenied) {
      secretsLocked = true;
      for (const key of secretKeys) secretsOnDisk.add(key);
    } else {
      for (const key of Object.keys(sr.secrets)) secretsOnDisk.add(key);
    }
  }
  // Only count config as "existing" based on actual values we read, not
  // phantom secrets assumed present because elevation was skipped.
  const hasExistingConfig = Object.keys(existingConfig).length > 0 || Object.keys(existingSecrets).length > 0;
  const existing = { ...(autoDefaults ?? {}), ...existingConfig, ...existingSecrets };

  // Check if all required fields already have values.
  // Secrets on disk count as "have a value" even if we couldn't read them.
  const missingRequired = fields.filter(
    (f) => !f.isOptional && !f.hasDefault && !existing[f.key] && !secretsOnDisk.has(f.key),
  );

  const useExisting = () => splitValuesByCategory(fields, existing);

  const isInstalled = !!(await readManifest(host)).components[component];

  if (isInstalled && hasExistingConfig) {
    if (missingRequired.length === 0) {
      const action = await promptOrExit(p.select({
        message: "All configuration variables are already set.",
        options: [
          { value: "skip", label: "Keep current configuration" },
          { value: "edit", label: "Edit configuration" },
        ],
      }));
      if (action === "skip") return useExisting();
      const result = await menuEditEnv(schema, existing, { secretsLocked });
      return result ?? useExisting();
    } else {
      p.log.info(
        `${missingRequired.length} new variable(s) need to be set. Edit any other values too if you like.`,
      );
      const newKeys = new Set(missingRequired.map((f) => f.key));
      const result = await menuEditEnv(schema, existing, { newKeys, secretsLocked });
      if (result === null) cancelAndExit();
      return result;
    }
  } else if (hasExistingConfig && missingRequired.length === 0) {
    // Not in manifest but has existing config, preserve original behavior
    const reconfigure = await promptOrExit(p.confirm({
      message: "Existing configuration found. Reconfigure?",
      initialValue: false,
    }));
    if (!reconfigure) return useExisting();
  }

  return promptForEnv(component, schema, existing);
}

// ─── Main orchestrator ─────────────────────────────────────────────────────

type ArtifactResult =
  | { status: "ready"; archivePath: string; versionString: string; isUpdate: boolean }
  | { status: "skipped"; version: string }
  | { status: "failed"; version: string };

async function resolveLocalArtifact(
  component: Component,
  repoPath: string,
  dryRun: boolean,
  host: Host,
): Promise<ArtifactResult> {
  const hostArch = await host.getArch();

  if (dryRun) {
    pass("Local build", `Would build ${component} from ${repoPath} for linux/${hostArch}`);
    return { status: "skipped", version: "local" };
  }

  const buildResult = await buildLocalArtifact(component, repoPath, hostArch as "x64" | "arm64");
  if (!buildResult) return { status: "failed", version: "" };

  const isUpdate = !!(await readManifest(host)).components[component];

  if (!host.isRemote) {
    return { status: "ready", archivePath: buildResult.archivePath, versionString: buildResult.version, isUpdate };
  }

  const remoteTmp = `/tmp/xinity-local-${Date.now()}.tar.gz`;
  const uploadSpinner = p.spinner();
  uploadSpinner.start("Uploading artifact...");
  try {
    await host.uploadFile(buildResult.archivePath, remoteTmp);
  } catch (err) {
    uploadSpinner.stop("Upload failed");
    fail("Upload", (err as Error).message);
    return { status: "failed", version: buildResult.version };
  }
  uploadSpinner.stop("Uploaded");

  const remoteHash = await host.computeSha256(remoteTmp);
  if (remoteHash && remoteHash !== buildResult.sha256) {
    fail("Verify", `Checksum mismatch after upload (local: ${buildResult.sha256}, remote: ${remoteHash})`);
    return { status: "failed", version: buildResult.version };
  }
  pass("Verify", "Checksum matched");
  return { status: "ready", archivePath: remoteTmp, versionString: buildResult.version, isUpdate };
}

/**
 * Resolve what to install: either build from a local repo (local: prefix) or
 * fetch the appropriate zip from a GitHub release. Returns a ready archive path
 * on the target host plus the version label and update flag.
 */
async function resolveArtifact(
  component: Component,
  targetVersion: string,
  dryRun: boolean,
  host: Host,
): Promise<ArtifactResult> {
  if (targetVersion.startsWith("local:")) {
    return resolveLocalArtifact(component, targetVersion.slice(6), dryRun, host);
  }

  // GitHub release path
  const versionResult = await resolveVersion(component, targetVersion, host);
  if (versionResult.status === "skipped") return { status: "skipped", version: versionResult.version };
  if (versionResult.status === "failed") return { status: "failed", version: "" };

  const { release, isUpdate } = versionResult;

  if (dryRun) {
    const hostArch = await host.getArch();
    return { status: "skipped", version: dryRunSummary(component, release, isUpdate, hostArch).version };
  }

  const hostArch = await host.getArch();
  let assetName: string;
  try {
    assetName = pickReleaseAsset(release, component, hostArch);
  } catch (err) {
    fail("Download", (err as Error).message);
    return { status: "failed", version: release.tagName };
  }
  let archivePath: string | null;

  if (host.isRemote) {
    archivePath = await downloadAndVerifyOnHost(release, assetName, host);
  } else {
    const tmpDir = join(tmpdir(), `xinity-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    archivePath = await downloadAndVerify(release, assetName, tmpDir);
  }

  if (!archivePath) return { status: "failed", version: release.tagName };
  return { status: "ready", archivePath, versionString: release.tagName, isUpdate };
}

function printServiceFailureDiagnostics(unit: string): void {
  p.log.warn(pc.yellow("Service failed to start. Diagnostic commands:"));
  p.log.info(`  ${pc.cyan(`systemctl status ${unit}`)}`);
  p.log.info(`  ${pc.cyan(`journalctl -u ${unit} -e --no-pager`)}`);
}

/**
 * Configure env, write unit, and start the service. Loops on failure to allow
 * the user to reconfigure and retry without re-downloading the binary.
 * Returns accumulated non-fatal errors (or null on a hard cancel/abort).
 */
async function configureAndStart(
  component: Component,
  autoDefaults: Record<string, string>,
  host: Host,
): Promise<string[] | null> {
  const errors: string[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const envResult = await configureEnv(component, host, autoDefaults);
    if (!envResult) return null; // user cancelled

    const wrote = await writeEnvConfig(component, envResult.config, envResult.secrets, host);
    if (!wrote) errors.push("Failed to write configuration (may need manual setup)");

    if (component === "daemon") {
      await ensureDriverTools(envResult.config, envResult.secrets, host);
    }

    const secretKeys = Object.keys(envResult.secrets);
    const unitInstalled = await writeSystemdUnit(component, secretKeys, host);
    if (!unitInstalled) {
      errors.push("Systemd unit not installed (may need manual setup)");
    }

    const started = await startService(component, host);
    if (started) return errors;

    const unit = unitName(component);
    printServiceFailureDiagnostics(unit);

    await host.withElevation(
      `systemctl disable --now ${unit} 2>/dev/null; systemctl reset-failed ${unit} 2>/dev/null`,
      `Disable ${unit}`,
    );

    const action = await p.select({
      message: "How would you like to proceed?",
      options: [
        { value: "retry", label: "Reconfigure and try again" },
        { value: "continue", label: "Continue anyway (service not running)" },
        { value: "abort", label: "Abort" },
      ],
    });

    if (p.isCancel(action) || action === "abort") return null;
    if (action === "continue") {
      errors.push("Service did not start successfully");
      return errors;
    }
    // retry → loop back to configureEnv
  }
}

export async function installComponent(opts: {
  component: Component;
  targetVersion: string;
  dryRun?: boolean;
  hardReset?: boolean;
  host?: Host;
  /** Extra env defaults carried from prior setup steps (e.g. DB_CONNECTION_URL, REDIS_URL). */
  envOverrides?: Record<string, string>;
}): Promise<InstallResult> {
  const { component, targetVersion, dryRun = false, hardReset = false } = opts;
  const host = opts.host ?? createLocalHost();

  // 1. Pre-checks
  const preErrors = await preChecks(component, host);
  if (preErrors.length > 0) {
    for (const err of preErrors) fail("Pre-check", err);
    return { success: false, version: "", errors: preErrors };
  }
  if (dryRun) pass("Pre-checks", "passed");

  // 2. Resolve version and download / build archive
  const artifact = await resolveArtifact(component, targetVersion, dryRun, host);
  if (artifact.status === "skipped") return { success: true, version: artifact.version, errors: [] };
  if (artifact.status === "failed") return { success: false, version: artifact.version, errors: ["Artifact resolution failed"] };

  const { archivePath, versionString, isUpdate } = artifact;

  // 3. Stop existing service if updating
  if (isUpdate) {
    await stopService(component, host);

    if (hardReset) {
      const unit = unitName(component);
      info("Hard reset", `Cleaning state for ${unit}…`);
      const result = await host.withElevation(
        `systemctl clean --what=state ${unit}`,
        `Clean state for ${unit}`,
      );
      reportElevationWarning(result, "Hard reset", `State cleaned for ${unit}`, "Failed to clean state");
    }
  }

  // 4. Install binary
  const installed = await installBinary(component, archivePath, host);
  if (!installed) return { success: false, version: versionString, errors: ["Installation failed or skipped"] };

  // 5. Configure env, install unit, start service (with retry loop)
  const autoDefaults = { ...getAutoDefaults(component), ...(opts.envOverrides ?? {}) };
  const errors = await configureAndStart(component, autoDefaults, host);
  if (errors === null) return { success: false, version: versionString, errors: ["Aborted"] };

  // 6. Update manifest
  const binaryPath = `${BIN_DIR}/${binaryBaseName(component)}`;
  const binaryChecksum = (await host.computeSha256(binaryPath)) ?? undefined;
  await updateManifestEntry(component, {
    version: versionString,
    installedAt: new Date().toISOString(),
    binaryPath,
    unitName: unitName(component),
    binaryChecksum,
  }, host);

  const success = errors.length === 0;
  if (success) pass("Done", `${component} ${versionString} installed successfully`);
  return { success, version: versionString, errors };
}

/** Show onboarding hints after a dashboard install. */
export async function showDashboardHints(host: Host): Promise<void> {
  const dashContent = await host.readFile(`${ENV_DIR}/dashboard.env`);
  const origin = dashContent ? parseEnvString(dashContent).ORIGIN : undefined;

  const lines: string[] = [];
  if (origin) {
    lines.push(`Dashboard:  ${pc.cyan(origin)}`);
    lines.push("");
    lines.push(pc.bold("Next steps:"));
    lines.push(`  1. Connect the CLI to your dashboard:`);
    lines.push(`     ${pc.cyan(`xinity configure dashboardUrl ${origin}`)}`);
    lines.push(`  2. Create your admin account from the CLI:`);
    lines.push(`     ${pc.cyan("xinity act onboarding.cli")}`);
    lines.push(`     Or open ${pc.cyan(origin)} in a browser to sign up there.`);
  } else {
    lines.push(pc.bold("Next steps:"));
    lines.push(`  1. Create your admin account via the dashboard UI`);
    lines.push(`     Or from the CLI: ${pc.cyan("xinity act onboarding.cli")}`);
  }

  p.note(lines.join("\n"), "Dashboard installed");
}

// ─── Dry run ───────────────────────────────────────────────────────────────

function dryRunSummary(
  component: Component,
  release: Release,
  isUpdate: boolean,
  arch?: string,
): InstallResult {
  let assetName: string;
  try {
    assetName = pickReleaseAsset(release, component, arch);
  } catch {
    assetName = `${assetPrefix(component, arch)}.tar.gz`;
  }
  const asset = release.assets.find((a) => a.name === assetName);
  const schema = ENV_SCHEMAS[component];
  const fields = analyzeEnvSchema(schema);
  const { configFields, secretFields } = categorizeFields(fields);
  const baseConfig = getComponentConfig(component);
  const unit = generateUnit({ ...baseConfig, secretKeys: secretFields.map((f) => f.key) });

  p.log.step(pc.bold("Actions that would be performed:"));

  // Version
  if (isUpdate) {
    info("Version", `Update to ${release.tagName}`);
  } else {
    info("Version", `Fresh install ${release.tagName}`);
  }

  // Download
  if (asset) {
    info("Download", `${assetName} (${assetSizeMb(asset)} MB)`);
  } else {
    warn("Download", `Asset ${assetName} not found in release`);
  }

  // Install path
  info("Install", `Binary → ${BIN_DIR}/${binaryBaseName(component)}`);

  // Env config
  info("Config", `${configFields.length} config fields → ${ENV_DIR}/${component}.env`);
  for (const f of configFields) {
    const def = f.hasDefault ? pc.dim(` [default: ${f.defaultValue}]`) : "";
    const opt = f.isOptional ? pc.dim(" (optional)") : "";
    p.log.info(`  ${f.key}${def}${opt}`);
  }

  // Secrets
  info("Secrets", `${secretFields.length} secret fields → ${SECRETS_DIR}/`);
  for (const f of secretFields) {
    const opt = f.isOptional ? pc.dim(" (optional)") : "";
    p.log.info(`  ${f.key}${opt}`);
  }

  // Systemd unit
  info("Systemd", `Unit → ${UNIT_DIR}/${unitName(component)}`);
  p.log.info(pc.dim(unit));

  // Service
  if (isUpdate) {
    info("Service", `Restart ${unitName(component)}`);
  } else {
    info("Service", `Enable and start ${unitName(component)}`);
  }

  return { success: true, version: release.tagName, errors: [] };
}

async function confirmContinueAfterFailure(warnLabel: string, warnDetail: string): Promise<boolean> {
  warn(warnLabel, warnDetail);
  const cont = await p.confirm({ message: "Continue with remaining components?", initialValue: true });
  return !p.isCancel(cont) && cont;
}

/**
 * Run an action for each component in sequence, prompting to continue on failure.
 * Returns true if all components completed, false if the user aborted mid-sequence.
 */
async function runComponentSequence<T extends { success: boolean; errors: string[] }>(
  components: Component[],
  action: (component: Component) => Promise<T>,
): Promise<boolean> {
  for (const component of components) {
    p.log.step(pc.bold(`\n── ${component} ──`));
    const result = await action(component);
    if (!result.success) {
      const proceed = await confirmContinueAfterFailure("Partial", `${component} had issues: ${result.errors.join(", ")}`);
      if (!proceed) return false;
    }
  }
  return true;
}

/** Install all components in sequence, carrying shared env vars forward. */
export async function installAll(targetVersion: string, dryRun = false, hardReset = false, host?: Host): Promise<void> {
  if (targetVersion.startsWith("local:")) {
    fail("Local build", "'xinity up all' does not support local: builds. Run 'xinity up <component>' for each component individually.");
    return;
  }

  const resolvedHost = host ?? createLocalHost();

  // Shared env vars accumulated across setup steps
  const shared: Record<string, string> = {};

  // ── 1. Database ────────────────────────────────────────────────────────
  p.log.step(pc.bold("\n── database ──"));
  const { runMigrations } = await import("./migrator.ts");
  const dbResult = await runMigrations({ targetVersion, dryRun, host: resolvedHost });
  if (!dbResult.success) {
    const proceed = await confirmContinueAfterFailure("Database", `Had issues: ${dbResult.errors.join(", ")}`);
    if (!proceed) return;
  }
  if (dbResult.connectionUrl) {
    shared.DB_CONNECTION_URL = dbResult.connectionUrl;
  }

  // ── 2. Redis ───────────────────────────────────────────────────────────
  p.log.step(pc.bold("\n── redis ──"));
  const { discoverRedisUrl } = await import("./redis-setup.ts");
  const redisUrl = await discoverRedisUrl(resolvedHost, dryRun);
  if (redisUrl) {
    shared.REDIS_URL = redisUrl;
  } else {
    warn("Redis", "No Redis URL configured");
    const cont = await p.confirm({ message: "Continue without Redis?", initialValue: true });
    if (p.isCancel(cont) || !cont) return;
  }

  // ── 3. Infoserver (optional) ───────────────────────────────────────────
  p.log.info(pc.dim(`Model registry guide: ${projectUrl()}/tree/main/packages/xinity-infoserver#readme`));
  const installInfoserver = await p.confirm({
    message: "Install the info server? (optional - most installations use the default at sysinfo.xinity.ai)",
    initialValue: false,
  });
  if (p.isCancel(installInfoserver)) return;

  if (installInfoserver) {
    p.log.step(pc.bold("\n── infoserver ──"));
    const result = await installComponent({
      component: "infoserver",
      targetVersion, dryRun, hardReset, host: resolvedHost,
      envOverrides: shared,
    });
    if (!result.success) {
      const proceed = await confirmContinueAfterFailure("Partial", `infoserver had issues: ${result.errors.join(", ")}`);
      if (!proceed) return;
    }
  }

  // ── 4+5. Gateway + Dashboard ───────────────────────────────────────────
  const coreOk = await runComponentSequence(["gateway", "dashboard"], (component) =>
    installComponent({ component, targetVersion, dryRun, hardReset, host: resolvedHost, envOverrides: shared }),
  );
  if (!coreOk) return;

  // ── 6. Daemon (optional) ──────────────────────────────────────────────
  const installDaemon = await p.confirm({
    message: "Install the daemon? (only needed on inference hardware)",
    initialValue: false,
  });
  if (p.isCancel(installDaemon)) return;

  if (installDaemon) {
    p.log.step(pc.bold("\n── daemon ──"));
    const result = await installComponent({
      component: "daemon",
      targetVersion, dryRun, hardReset, host: resolvedHost,
      envOverrides: shared,
    });
    if (!result.success) {
      warn("Partial", `daemon had issues: ${result.errors.join(", ")}`);
    }
  }

  // ── Health check ──────────────────────────────────────────────────────
  p.log.step(pc.bold("\n── health check ──"));
  const { runDoctor } = await import("./doctor.ts");
  const doctorSpinner = p.spinner();
  doctorSpinner.start("Running diagnostics…");
  const report = await runDoctor({
    interactive: false,
    host: resolvedHost,
    spinner: {
      message: (msg: string) => doctorSpinner.message(msg),
      stop: () => doctorSpinner.stop(""),
    },
  });
  doctorSpinner.stop("");

  const { pass: passCount, warn: warnCount, fail: failCount } = report.summary;
  if (failCount > 0) {
    warn("Health", `${failCount} check(s) failed. Run ${pc.cyan("xinity doctor")} for details.`);
  } else if (warnCount > 0) {
    pass("Health", `All checks passed (${warnCount} warning(s))`);
  } else {
    pass("Health", `All ${passCount} checks passed`);
  }

  // ── Post-install summary ──────────────────────────────────────────────
  const summaryLines: string[] = [];

  const dashContent = await resolvedHost.readFile(`${ENV_DIR}/dashboard.env`);
  const dashboardOrigin = dashContent ? parseEnvString(dashContent).ORIGIN : undefined;
  if (dashboardOrigin) summaryLines.push(`Dashboard:  ${pc.cyan(dashboardOrigin)}`);

  const gwContent = await resolvedHost.readFile(`${ENV_DIR}/gateway.env`);
  if (gwContent) {
    const parsed = parseEnvString(gwContent);
    const gwHost = parsed.HOST || "localhost";
    const gwPort = parsed.PORT || "4010";
    summaryLines.push(`Gateway:    ${pc.cyan(`http://${gwHost}:${gwPort}`)}`);
  }

  if (summaryLines.length > 0) summaryLines.push("");
  summaryLines.push(pc.bold("Next steps:"));
  if (dashboardOrigin) {
    summaryLines.push(`  1. Connect the CLI to your dashboard:`);
    summaryLines.push(`     ${pc.cyan(`xinity configure dashboardUrl ${dashboardOrigin}`)}`);
    summaryLines.push(`  2. Create your admin account from the CLI:`);
    summaryLines.push(`     ${pc.cyan("xinity act onboarding.cli")}`);
    summaryLines.push(`     Or open ${pc.cyan(dashboardOrigin)} in a browser to sign up there.`);
  } else {
    summaryLines.push(`  1. Create your admin account via the dashboard UI`);
    summaryLines.push(`     Or from the CLI: ${pc.cyan("xinity act onboarding.cli")}`);
  }
  summaryLines.push(`  ${dashboardOrigin ? "3" : "2"}. Add inference nodes: ${pc.cyan("xinity up daemon")} on each GPU machine`);
  summaryLines.push(`  ${dashboardOrigin ? "4" : "3"}. Check health anytime: ${pc.cyan("xinity doctor")}`);
  summaryLines.push("");
  summaryLines.push(pc.dim(`Model registry guide: ${projectUrl()}/tree/main/packages/xinity-infoserver#readme`));

  p.note(summaryLines.join("\n"), "Installation complete");
}

// ─── Remove ─────────────────────────────────────────────────────────────────


function reportElevationStep(
  result: { success: boolean; skipped: boolean; output: string },
  label: string,
  successMsg: string,
  failurePrefix: string,
  errors: string[],
): void {
  if (result.success) {
    pass(label, successMsg);
  } else if (!result.skipped) {
    errors.push(`${failurePrefix}: ${result.output}`);
  }
}

function reportElevationWarning(
  result: { success: boolean; skipped: boolean; output: string },
  label: string,
  successMsg: string,
  failurePrefix: string,
): void {
  if (result.success) {
    pass(label, successMsg);
  } else if (!result.skipped) {
    warn(label, `${failurePrefix}: ${result.output}`);
  }
}

export async function removeComponent(opts: {
  component: Component;
  purge?: boolean;
  host?: Host;
}): Promise<RemoveResult> {
  const { component, purge = false } = opts;
  const host = opts.host ?? createLocalHost();
  const errors: string[] = [];
  const manifest = await readManifest(host);
  const entry = manifest.components[component];

  if (!entry) {
    warn("Not installed", `${component} is not in the manifest`);
    // Still try to clean up in case of partial installs
  }

  const unit = unitName(component);

  // 1. Stop and disable the service
  if (await isUnitActiveOn(host, unit)) {
    info("Service", `Stopping ${unit}…`);
    const result = await host.withElevation(
      `systemctl disable --now ${unit}`,
      `Stop and disable ${unit}`,
    );
    reportElevationStep(result, "Service", `${unit} stopped and disabled`, `Failed to stop ${unit}`, errors);
  } else {
    // Try to disable even if not active (might be enabled but failed)
    await host.withElevation(`systemctl disable ${unit} 2>/dev/null || true`, `Disable ${unit}`);
    info("Service", `${unit} was not running`);
  }

  // 2. Remove systemd unit file + daemon-reload
  const unitPath = `${UNIT_DIR}/${unit}`;
  const rmUnit = await host.withElevation(
    `rm -f ${unitPath} && systemctl daemon-reload`,
    `Remove ${unit} unit file`,
  );
  reportElevationStep(rmUnit, "Systemd", `Removed ${unitPath}`, "Failed to remove unit", errors);

  // 3. Remove binary and (for dashboard) any legacy tarball directory
  const binaryPath = `${BIN_DIR}/${binaryBaseName(component)}`;
  const rmBin = await host.withElevation(
    component === "dashboard"
      ? `rm -f ${binaryPath} && rm -rf ${DASHBOARD_DIR} 2>/dev/null || true`
      : `rm -f ${binaryPath}`,
    `Remove ${component} binary`,
  );
  reportElevationStep(rmBin, "Files", `Removed ${binaryPath}`, "Failed to remove binary", errors);

  // 4. Remove env config file
  const envPath = `${ENV_DIR}/${component}.env`;
  const rmEnv = await host.withElevation(
    `rm -f ${envPath}`,
    `Remove ${component} env config`,
  );
  reportElevationStep(rmEnv, "Config", `Removed ${envPath}`, "Failed to remove env config", errors);

  // 5. Remove secret files that no other installed component needs.
  const schema = ENV_SCHEMAS[component];
  const fields = analyzeEnvSchema(schema);
  const { secretFields } = categorizeFields(fields);
  if (secretFields.length > 0) {
    const manifest = await readManifest(host);
    const otherComponents = (Object.keys(ENV_SCHEMAS) as Component[])
      .filter((c) => c !== component && manifest.components[c]);
    const sharedKeys = new Set(
      otherComponents.flatMap((c) => {
        const { secretFields: sf } = categorizeFields(analyzeEnvSchema(ENV_SCHEMAS[c]));
        return sf.map((f) => f.key);
      }),
    );

    const toDelete = secretFields.filter((f) => !sharedKeys.has(f.key));
    const kept = secretFields.filter((f) => sharedKeys.has(f.key));

    if (kept.length > 0) {
      info("Secrets", `Keeping ${kept.map((f) => f.key).join(", ")} (used by other components)`);
    }

    if (toDelete.length > 0) {
      const secretPaths = toDelete.map((f) => `${SECRETS_DIR}/${f.key}`).join(" ");
      const rmSecrets = await host.withElevation(
        `rm -f ${secretPaths}`,
        `Remove ${component} secret files`,
      );
      reportElevationStep(rmSecrets, "Secrets", `Removed ${toDelete.length} secret file(s)`, "Failed to remove secrets", errors);
    }
  }

  // 6. Remove daemon-specific extras: vLLM template unit (always) and /etc/vllm (on purge)
  if (component === "daemon") {
    const vllmTemplatePath = `${UNIT_DIR}/vllm-driver@.service`;
    const rmTemplate = await host.withElevation(
      `rm -f ${vllmTemplatePath} && systemctl daemon-reload`,
      "Remove vLLM systemd template unit",
    );
    reportElevationStep(rmTemplate, "vLLM", `Removed ${vllmTemplatePath}`, "Failed to remove vLLM template", errors);

    if (purge) {
      const rmVllmEnv = await host.withElevation(
        "rm -rf /etc/vllm",
        "Purge vLLM environment config",
      );
      reportElevationStep(rmVllmEnv, "Purge", "Removed /etc/vllm", "Failed to purge /etc/vllm", errors);
    }
  }

  // 7. Purge state data if requested
  if (purge) {
    const stateDir = `/var/lib/xinity-ai-${component}`;
    const rmState = await host.withElevation(
      `rm -rf ${stateDir}`,
      `Purge ${component} state data`,
    );
    reportElevationStep(rmState, "Purge", `Removed ${stateDir}`, "Failed to purge state", errors);
  }

  // 8. Remove manifest entry
  delete manifest.components[component];
  await writeManifest(manifest, host);
  pass("Manifest", `Removed ${component} from manifest`);

  const success = errors.length === 0;
  if (success) {
    pass("Done", `${component} removed successfully`);
  }

  return { success, errors };
}

/** Remove all components in sequence. */
export async function removeAll(purge = false, host?: Host): Promise<void> {
  const h = host ?? createLocalHost();
  await runComponentSequence(
    ["gateway", "dashboard", "daemon", "infoserver"],
    (component) => removeComponent({ component, purge, host: h }),
  );

  // Clean up empty directories
  p.log.step(pc.bold("\n── Cleanup ──"));
  const cleanDirs = [
    `rmdir ${SECRETS_DIR} 2>/dev/null || true`,
    `rmdir ${ENV_DIR} 2>/dev/null || true`,
    `rmdir ${BIN_DIR} 2>/dev/null || true`,
    `rmdir /opt/xinity 2>/dev/null || true`,
  ].join(" && ");
  await h.withElevation(cleanDirs, "Clean up empty directories");
}
