import * as p from "./clack.ts";
import { fetchChecksums, verifySha256, resolveDirectUrl, type Release } from "./github.ts";
import { pass, fail, warn, elevationHardFailed } from "./output.ts";
import { type Component, BIN_DIR, DASHBOARD_DIR, binaryBaseName } from "./component-meta.ts";
import { type Host, createLocalHost } from "./host.ts";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
import { downloadAsset, pickReleaseAsset } from "./github.ts";

export type { Release } from "./github.ts";

function findReleaseAssetOrFail(release: Release, assetName: string): Release["assets"][number] | null {
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    fail("Download", `Asset ${assetName} not found in release ${release.tagName}`);
    return null;
  }
  return asset;
}

export function assetSizeMb(asset: { size: number }): string {
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

export async function downloadAndVerifyOnHost(
  release: Release,
  assetName: string,
  host: Host,
): Promise<string | null> {
  const asset = findReleaseAssetOrFail(release, assetName);
  if (!asset) return null;

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

export async function installBinary(component: Component, archivePath: string, host: Host): Promise<boolean> {
  const binName = binaryBaseName(component);

  if (host.isRemote) {
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

  if (component === "dashboard") {
    await host.withElevation(
      `rm -rf ${DASHBOARD_DIR} 2>/dev/null || true`,
      "Remove legacy dashboard directory",
    );
  }

  pass("Install", "Installed");
  return true;
}

export async function resolveRemoteArtifact(
  release: Release,
  component: Component,
  host: Host,
): Promise<string | null> {
  const hostArch = await host.getArch();
  let assetName: string;
  try {
    assetName = pickReleaseAsset(release, component, hostArch);
  } catch (err) {
    fail("Download", (err as Error).message);
    return null;
  }

  if (host.isRemote) {
    return downloadAndVerifyOnHost(release, assetName, host);
  }

  const tmpDir = join(tmpdir(), `xinity-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  return downloadAndVerify(release, assetName, tmpDir);
}
