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

import { fetchRelease, downloadAsset, fetchChecksums, verifySha256, getAssetName, resolveDirectUrl, type Release } from "./github.ts";
import { loadConfig } from "./config.ts";
import { buildLocalArtifact } from "./local-build.ts";
import { readManifest, updateManifestEntry, writeManifest } from "./manifest.ts";
import { generateUnit, getComponentConfig, unitName, type UnitConfig } from "./systemd.ts";
import { analyzeEnvSchema, categorizeFields, promptForEnv } from "./env-prompt.ts";
import { parseEnvString } from "./env-file.ts";
import { pass, fail, warn, info, cancelAndExit } from "./output.ts";
import { type Host, createLocalHost, commandExistsOn, isUnitActiveOn, readSecrets } from "./host.ts";
import { writeEnvConfig, stopService, startService } from "./service.ts";
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

  // unzip is needed for binary extraction (all service components)
  const needsUnzip = components.some(
    (c) => c === "all" || serviceComponents.includes(c),
  );
  if (needsUnzip) {
    const target = host.isRemote ? "the remote host" : "this machine";
    await check("unzip", `required on ${target} for binary extraction`, "apt install unzip / dnf install unzip / pacman -S unzip");
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

  if (result.success) {
    pass("vLLM template", `Installed at ${templatePath}`);
  } else if (!result.skipped) {
    warn("vLLM template", `Failed to install: ${result.output}`);
  }
}

// ─── Driver tool checks (daemon only) ───────────────────────────────────────

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
      if (await isUnitActiveOn(host, "ollama.service") || await isUnitActiveOn(host, "ollama")) {
        pass("Ollama", "ollama service is running");
      } else {
        const startIt = await p.confirm({
          message: "Ollama is installed but the service is not running. Start it?",
          initialValue: true,
        });
        if (!p.isCancel(startIt) && startIt) {
          const result = await host.withElevation(
            "systemctl enable --now ollama",
            "Start ollama service",
          );
          if (result.success) {
            pass("Ollama", "ollama service started");
          } else if (!result.skipped) {
            warn("Ollama", `Failed to start ollama: ${result.output}`);
          }
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
          let ollamaRunning = false;
          for (let i = 0; i < 10; i++) {
            await Bun.sleep(500);
            ollamaRunning = (await isUnitActiveOn(host, "ollama.service")) || (await isUnitActiveOn(host, "ollama"));
            if (ollamaRunning) break;
          }
          ollamaSpinner.stop(ollamaRunning ? "Service running" : "Service not started automatically");

          if (!ollamaRunning) {
            const startResult = await host.withElevation(
              "systemctl enable --now ollama",
              "Start ollama service",
            );
            if (startResult.success) {
              pass("Ollama", "ollama service started");
            }
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

    const templatePath = all.VLLM_TEMPLATE_UNIT_PATH ?? "/etc/systemd/system/vllm-driver@.service";
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
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    fail("Download", `Asset ${assetName} not found in release ${release.tagName}`);
    return null;
  }

  const spinner = p.spinner();
  const sizeMb = (asset.size / 1024 / 1024).toFixed(1);
  spinner.start(`Downloading ${assetName} (${sizeMb} MB)…`);

  let filePath: string;
  try {
    filePath = await downloadAsset(asset, destDir);
  } catch (err) {
    spinner.stop("Download failed");
    fail("Download", (err as Error).message);
    return null;
  }
  spinner.stop("Downloaded");

  // Verify checksum
  const checksumSpinner = p.spinner();
  checksumSpinner.start("Verifying checksum…");
  const checksums = await fetchChecksums(release);
  const expected = checksums.get(assetName);
  if (expected) {
    const valid = await verifySha256(filePath, expected);
    if (!valid) {
      checksumSpinner.stop("Verification failed");
      fail("Checksum", "SHA256 mismatch, the download may be corrupted");
      return null;
    }
    checksumSpinner.stop("Checksum verified");
  } else {
    checksumSpinner.stop("No checksums available");
    warn("Checksum", "No SHASUMS256.txt found in release, skipping verification");
  }

  return filePath;
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
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    fail("Download", `Asset ${assetName} not found in release ${release.tagName}`);
    return null;
  }

  const sizeMb = (asset.size / 1024 / 1024).toFixed(1);

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
  dlSpinner.start(`Downloading ${assetName} on remote host (${sizeMb} MB)…`);
  try {
    await host.run(["mkdir", "-p", remoteTmpDir]);
    await host.downloadFile(directUrl, remotePath);
  } catch (err) {
    dlSpinner.stop("Download failed");
    fail("Download", (err as Error).message);
    return null;
  }
  dlSpinner.stop("Downloaded on remote");

  // Verify checksum on the remote host
  const checksumSpinner = p.spinner();
  checksumSpinner.start("Verifying checksum on remote…");
  const checksums = await fetchChecksums(release);
  const expected = checksums.get(assetName);
  if (expected) {
    const valid = await host.verifySha256(remotePath, expected);
    if (!valid) {
      checksumSpinner.stop("Verification failed");
      fail("Checksum", "SHA256 mismatch, the download may be corrupted");
      return null;
    }
    checksumSpinner.stop("Checksum verified on remote");
  } else {
    checksumSpinner.stop("No checksums available");
    warn("Checksum", "No SHASUMS256.txt found in release, skipping verification");
  }

  return remotePath;
}

// ─── Install binary ────────────────────────────────────────────────────────

async function installBinary(component: Component, archivePath: string, host: Host): Promise<boolean> {
  const binName = binaryBaseName(component);

  if (host.isRemote) {
    // Archive already on remote, extract and install directly
    const tmpExtract = archivePath.replace(/\.zip$/, "");
    const result = await host.withElevation(
      `mkdir -p ${tmpExtract} && unzip -o ${archivePath} -d ${tmpExtract}` +
      ` && mkdir -p ${BIN_DIR} && rm -f ${BIN_DIR}/${binName}` +
      ` && cp ${tmpExtract}/${binName} ${BIN_DIR}/${binName}` +
      ` && chmod +x ${BIN_DIR}/${binName}` +
      ` && rm -rf ${tmpExtract} ${archivePath}`,
      `Install ${binName} binary`,
    );
    if (!result.success && !result.skipped) {
      fail("Install", result.output);
      return false;
    }
    if (result.skipped) return false;
  } else {
    // Local: extract locally, upload binary, place on host
    const tmpExtract = archivePath.replace(/\.zip$/, "");
    mkdirSync(tmpExtract, { recursive: true });

    const extractSpinner = p.spinner();
    extractSpinner.start("Extracting…");
    const local = createLocalHost();
    const unzip = await local.run(["unzip", "-o", archivePath, "-d", tmpExtract]);
    if (!unzip.ok) {
      extractSpinner.stop("Extract failed");
      fail("Extract", unzip.output);
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
    if (!result.success && !result.skipped) {
      fail("Install", result.output);
      return false;
    }
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
  if (secretKeys.length > 0) {
    const sr = await readSecrets(host, SECRETS_DIR, secretKeys, "Read existing secrets");
    existingSecrets = sr.secrets;
    if (sr.skipped || sr.permissionDenied) {
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

  // Helper to return existing values split by config/secrets
  const useExisting = (): { config: Record<string, string>; secrets: Record<string, string> } => {
    const config: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const field of fields) {
      const val = existing[field.key];
      if (val === undefined) continue;
      if (field.isSecret) secrets[field.key] = val;
      else config[field.key] = val;
    }
    return { config, secrets };
  };

  const isInstalled = !!(await readManifest(host)).components[component];

  // If the component is already installed and has existing config,
  // offer to skip re-entering already-configured variables
  if (isInstalled && hasExistingConfig) {
    if (missingRequired.length === 0) {
      // All config variables are already set, offer to keep current configuration
      const action = await p.select({
        message: "All configuration variables are already set.",
        options: [
          { value: "skip", label: "Keep current configuration" },
          { value: "reconfigure", label: "Reconfigure all variables" },
        ],
      });
      if (p.isCancel(action)) cancelAndExit();
      if (action === "skip") return useExisting();
    } else {
      // Some new variables need to be configured, offer to skip the rest
      const alreadySetCount = fields.filter((f) => existing[f.key] !== undefined || secretsOnDisk.has(f.key)).length;
      const action = await p.select({
        message: `${alreadySetCount} of ${fields.length} variables are already configured. ${missingRequired.length} new variable(s) need to be set.`,
        options: [
          { value: "new-only", label: "Only configure new variables" },
          { value: "reconfigure", label: "Reconfigure all variables" },
        ],
      });
      if (p.isCancel(action)) cancelAndExit();
      if (action === "new-only") {
        const skipKeys = new Set(
          fields.filter((f) => existing[f.key] !== undefined || secretsOnDisk.has(f.key)).map((f) => f.key),
        );
        return promptForEnv(component, schema, existing, skipKeys);
      }
    }
  } else if (hasExistingConfig && missingRequired.length === 0) {
    // Not in manifest but has existing config, preserve original behavior
    const reconfigure = await p.confirm({
      message: "Existing configuration found. Reconfigure?",
      initialValue: false,
    });
    if (p.isCancel(reconfigure)) cancelAndExit();
    if (!reconfigure) return useExisting();
  }

  return promptForEnv(component, schema, existing);
}

// ─── Systemd unit ──────────────────────────────────────────────────────────

async function installUnit(component: Component, secretKeys: string[], host: Host): Promise<boolean> {
  const baseConfig = getComponentConfig(component);
  const config: UnitConfig = { ...baseConfig, secretKeys };

  const unitContent = generateUnit(config);
  const unitPath = `${UNIT_DIR}/${unitName(component)}`;

  const result = await host.withElevation(
    `cat > ${unitPath} << 'UNITEOF'\n${unitContent}UNITEOF\nsystemctl daemon-reload`,
    `Install ${component} systemd unit`,
  );

  if (!result.success && !result.skipped) {
    fail("Systemd", result.output);
    return false;
  }
  if (result.skipped) return false;

  pass("Systemd", `Unit installed at ${unitPath}`);
  return true;
}

// ─── Main orchestrator ─────────────────────────────────────────────────────

type ArtifactResult =
  | { status: "ready"; archivePath: string; versionString: string; isUpdate: boolean }
  | { status: "skipped"; version: string }
  | { status: "failed"; version: string };

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
    const repoPath = targetVersion.slice(6);
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

    const remoteTmp = `/tmp/xinity-local-${Date.now()}.zip`;
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
  const assetName = getAssetName(component, hostArch);
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
    const unitInstalled = await installUnit(component, secretKeys, host);
    if (!unitInstalled) errors.push("Systemd unit not installed (may need manual setup)");

    const started = await startService(component, host);
    if (started) return errors;

    // Service failed - show diagnostics and offer retry
    const unit = unitName(component);
    p.log.warn(pc.yellow("Service failed to start. Diagnostic commands:"));
    p.log.info(`  ${pc.cyan(`systemctl status ${unit}`)}`);
    p.log.info(`  ${pc.cyan(`journalctl -u ${unit} -e --no-pager`)}`);

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
      if (result.success) {
        pass("Hard reset", `State cleaned for ${unit}`);
      } else if (!result.skipped) {
        warn("Hard reset", `Failed to clean state: ${result.output}`);
      }
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
  const assetName = getAssetName(component, arch);
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
    const sizeMb = (asset.size / 1024 / 1024).toFixed(1);
    info("Download", `${assetName} (${sizeMb} MB)`);
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

/** Run an action for each component in sequence, prompting to continue on failure. */
/** Returns true if all components completed, false if the user aborted mid-sequence. */
async function runComponentSequence<T extends { success: boolean; errors: string[] }>(
  components: Component[],
  action: (component: Component) => Promise<T>,
): Promise<boolean> {
  for (const component of components) {
    p.log.step(pc.bold(`\n── ${component} ──`));
    const result = await action(component);
    if (!result.success) {
      warn("Partial", `${component} had issues: ${result.errors.join(", ")}`);
      const cont = await p.confirm({
        message: "Continue with remaining components?",
        initialValue: true,
      });
      if (p.isCancel(cont) || !cont) return false;
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
    warn("Database", `Had issues: ${dbResult.errors.join(", ")}`);
    const cont = await p.confirm({ message: "Continue with remaining components?", initialValue: true });
    if (p.isCancel(cont) || !cont) return;
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
      warn("Partial", `infoserver had issues: ${result.errors.join(", ")}`);
      const cont = await p.confirm({ message: "Continue with remaining components?", initialValue: true });
      if (p.isCancel(cont) || !cont) return;
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
    if (result.success) {
      pass("Service", `${unit} stopped and disabled`);
    } else if (!result.skipped) {
      errors.push(`Failed to stop ${unit}: ${result.output}`);
    }
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
  if (rmUnit.success) {
    pass("Systemd", `Removed ${unitPath}`);
  } else if (!rmUnit.skipped) {
    errors.push(`Failed to remove unit: ${rmUnit.output}`);
  }

  // 3. Remove binary and (for dashboard) any legacy tarball directory
  const binaryPath = `${BIN_DIR}/${binaryBaseName(component)}`;
  const rmBin = await host.withElevation(
    component === "dashboard"
      ? `rm -f ${binaryPath} && rm -rf ${DASHBOARD_DIR} 2>/dev/null || true`
      : `rm -f ${binaryPath}`,
    `Remove ${component} binary`,
  );
  if (rmBin.success) {
    pass("Files", `Removed ${binaryPath}`);
  } else if (!rmBin.skipped) {
    errors.push(`Failed to remove binary: ${rmBin.output}`);
  }

  // 4. Remove env config file
  const envPath = `${ENV_DIR}/${component}.env`;
  const rmEnv = await host.withElevation(
    `rm -f ${envPath}`,
    `Remove ${component} env config`,
  );
  if (rmEnv.success) {
    pass("Config", `Removed ${envPath}`);
  } else if (!rmEnv.skipped) {
    errors.push(`Failed to remove env config: ${rmEnv.output}`);
  }

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
      if (rmSecrets.success) {
        pass("Secrets", `Removed ${toDelete.length} secret file(s)`);
      } else if (!rmSecrets.skipped) {
        errors.push(`Failed to remove secrets: ${rmSecrets.output}`);
      }
    }
  }

  // 6. Remove daemon-specific extras: vLLM template unit (always) and /etc/vllm (on purge)
  if (component === "daemon") {
    const vllmTemplatePath = "/etc/systemd/system/vllm-driver@.service";
    const rmTemplate = await host.withElevation(
      `rm -f ${vllmTemplatePath} && systemctl daemon-reload`,
      "Remove vLLM systemd template unit",
    );
    if (rmTemplate.success) pass("vLLM", `Removed ${vllmTemplatePath}`);
    else if (!rmTemplate.skipped) errors.push(`Failed to remove vLLM template: ${rmTemplate.output}`);

    if (purge) {
      const rmVllmEnv = await host.withElevation(
        "rm -rf /etc/vllm",
        "Purge vLLM environment config",
      );
      if (rmVllmEnv.success) pass("Purge", "Removed /etc/vllm");
      else if (!rmVllmEnv.skipped) errors.push(`Failed to purge /etc/vllm: ${rmVllmEnv.output}`);
    }
  }

  // 7. Purge state data if requested
  if (purge) {
    const stateDir = `/var/lib/xinity-ai-${component}`;
    const rmState = await host.withElevation(
      `rm -rf ${stateDir}`,
      `Purge ${component} state data`,
    );
    if (rmState.success) {
      pass("Purge", `Removed ${stateDir}`);
    } else if (!rmState.skipped) {
      errors.push(`Failed to purge state: ${rmState.output}`);
    }
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
