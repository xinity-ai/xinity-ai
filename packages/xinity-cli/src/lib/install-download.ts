import { fetchChecksums, verifySha256, resolveDirectUrl, downloadAsset, pickReleaseAsset, type Release } from "./github.ts";
import { type Component, BIN_DIR, DASHBOARD_DIR, binaryBaseName } from "./component-meta.ts";
import type { Host } from "./host.ts";
import type { StepEvent } from "./step-event.ts";

function findReleaseAsset(release: Release, assetName: string): Release["assets"][number] | null {
  return release.assets.find((a) => a.name === assetName) ?? null;
}

export function assetSizeMb(asset: { size: number }): string {
  return (asset.size / 1024 / 1024).toFixed(1);
}

async function* verifyReleaseChecksum(
  release: Release,
  assetName: string,
  filePath: string,
  verify: (path: string, expected: string) => Promise<boolean>,
  successLabel: string,
): AsyncGenerator<StepEvent, boolean> {
  yield { type: "spinner", id: "checksum", message: "Verifying checksum…" };
  const checksums = await fetchChecksums(release);
  if (checksums.size === 0) {
    yield { type: "spinner", id: "checksum", message: "No checksums available", done: true };
    yield { type: "warn", label: "Checksum", detail: "No SHASUMS256.txt found in release, skipping verification" };
    return true;
  }
  const expected = checksums.get(assetName);
  if (!expected) {
    yield { type: "spinner", id: "checksum", message: "No checksum entry", done: true };
    yield { type: "warn", label: "Checksum", detail: `No checksum entry for ${assetName} in SHASUMS256.txt, skipping verification` };
    return true;
  }
  const valid = await verify(filePath, expected);
  if (!valid) {
    yield { type: "spinner", id: "checksum", message: "Verification failed", done: true };
    yield { type: "fail", label: "Checksum", detail: "SHA256 mismatch, the download may be corrupted" };
    return false;
  }
  yield { type: "spinner", id: "checksum", message: successLabel, done: true };
  return true;
}

/**
 * Download a release asset to a local directory using fetch().
 * Used for CLI-machine operations (self-update, migration archive extraction)
 * that always run on the machine where the CLI process lives.
 */
export async function* downloadAndVerify(
  release: Release,
  assetName: string,
  destDir: string,
): AsyncGenerator<StepEvent, string | null> {
  const asset = findReleaseAsset(release, assetName);
  if (!asset) {
    yield { type: "fail", label: "Download", detail: `Asset ${assetName} not found in release ${release.tagName}` };
    return null;
  }

  yield { type: "spinner", id: "download", message: `Downloading ${assetName} (${assetSizeMb(asset)} MB)…` };

  let filePath: string;
  try {
    filePath = await downloadAsset(asset, destDir);
  } catch (err) {
    yield { type: "spinner", id: "download", message: "Download failed", done: true };
    yield { type: "fail", label: "Download", detail: (err as Error).message };
    return null;
  }
  yield { type: "spinner", id: "download", message: "Downloaded", done: true };

  const verified = yield* verifyReleaseChecksum(release, assetName, filePath, verifySha256, "Checksum verified");
  return verified ? filePath : null;
}

export async function* downloadAndVerifyOnHost(
  release: Release,
  assetName: string,
  host: Host,
): AsyncGenerator<StepEvent, string | null> {
  const asset = findReleaseAsset(release, assetName);
  if (!asset) {
    yield { type: "fail", label: "Download", detail: `Asset ${assetName} not found in release ${release.tagName}` };
    return null;
  }

  yield { type: "spinner", id: "url-resolve", message: "Resolving download URL…" };
  let directUrl: string;
  try {
    directUrl = await resolveDirectUrl(asset);
  } catch (err) {
    yield { type: "spinner", id: "url-resolve", message: "URL resolution failed", done: true };
    yield { type: "fail", label: "Download", detail: (err as Error).message };
    return null;
  }
  yield { type: "spinner", id: "url-resolve", message: "URL resolved", done: true };

  const tmpDir = `/tmp/xinity-download-${Date.now()}`;
  const destPath = `${tmpDir}/${assetName}`;

  yield { type: "spinner", id: "download", message: `Downloading ${assetName} (${assetSizeMb(asset)} MB)…` };
  try {
    await host.run(["mkdir", "-p", tmpDir]);
    await host.downloadFile(directUrl, destPath);
  } catch (err) {
    yield { type: "spinner", id: "download", message: "Download failed", done: true };
    yield { type: "fail", label: "Download", detail: (err as Error).message };
    return null;
  }
  yield { type: "spinner", id: "download", message: "Downloaded", done: true };

  const verified = yield* verifyReleaseChecksum(
    release, assetName, destPath,
    (path, expected) => host.verifySha256(path, expected),
    "Checksum verified",
  );
  return verified ? destPath : null;
}

export function extractCommandArgv(archivePath: string, destDir: string): string[] {
  if (archivePath.endsWith(".tar.gz")) {
    return ["tar", "-xzf", archivePath, "-C", destDir];
  }
  if (archivePath.endsWith(".zip")) {
    return ["unzip", "-o", archivePath, "-d", destDir];
  }
  throw new Error(`Unsupported archive format: ${archivePath}`);
}

function extractCommand(archivePath: string, destDir: string): string {
  return extractCommandArgv(archivePath, destDir).join(" ");
}

function stripArchiveSuffix(path: string): string {
  return path.replace(/\.tar\.gz$|\.zip$/, "");
}

/**
 * The exact root shell command that extracts an archive and installs the
 * component binary. Shared with the review phase's script dump.
 */
export function buildInstallBinaryCommand(component: Component, archivePath: string): string {
  const binName = binaryBaseName(component);
  const tmpExtract = stripArchiveSuffix(archivePath);
  return (
    `mkdir -p ${tmpExtract} && ${extractCommand(archivePath, tmpExtract)}` +
    ` && mkdir -p ${BIN_DIR} && rm -f ${BIN_DIR}/${binName}` +
    ` && cp ${tmpExtract}/${binName} ${BIN_DIR}/${binName}` +
    ` && chmod +x ${BIN_DIR}/${binName}` +
    ` && rm -rf ${tmpExtract} ${archivePath}`
  );
}

export async function* installBinary(
  component: Component,
  archivePath: string,
  host: Host,
): AsyncGenerator<StepEvent, boolean> {
  const binName = binaryBaseName(component);

  const result = await host.withElevation(
    buildInstallBinaryCommand(component, archivePath),
    `Install ${binName} binary`,
  );
  if (!result.success) {
    yield { type: "fail", label: "Install", detail: result.output };
    return false;
  }

  if (component === "dashboard") {
    await host.withElevation(
      `rm -rf ${DASHBOARD_DIR} 2>/dev/null || true`,
      "Remove legacy dashboard directory",
    );
  }

  yield { type: "pass", label: "Install", detail: "Installed" };
  return true;
}

export async function* resolveRemoteArtifact(
  release: Release,
  component: Component,
  host: Host,
): AsyncGenerator<StepEvent, string | null> {
  const hostArch = await host.getArch();
  let assetName: string;
  try {
    assetName = pickReleaseAsset(release, component, hostArch);
  } catch (err) {
    yield { type: "fail", label: "Download", detail: (err as Error).message };
    return null;
  }

  return yield* downloadAndVerifyOnHost(release, assetName, host);
}
