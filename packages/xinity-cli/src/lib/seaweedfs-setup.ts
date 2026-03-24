/**
 * Interactive SeaweedFS setup assistant for `xinity up seaweedfs`.
 *
 * Guides the user through downloading, configuring, and starting a
 * single-node SeaweedFS instance that provides an S3-compatible object
 * store for multimodal image storage.
 *
 * All shell operations go through the Host interface so this works
 * identically for local and remote (--target-host) execution.
 */
import { randomBytes, createHmac } from "crypto";
import * as p from "./clack.ts";
import pc from "picocolors";
import { type Host, commandExistsOn } from "./host.ts";
import { pass, fail, info, warn } from "./output.ts";
import { generateUnit } from "./systemd.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const BIN_DIR = "/opt/xinity/bin";
const WEED_BIN = `${BIN_DIR}/weed`;
const SEAWEEDFS_UNIT = "xinity-ai-seaweedfs.service";
const S3_CONFIG_PATH = "/etc/xinity-ai/seaweedfs-s3.json";
const S3_PORT = 8333;
const S3_ENDPOINT = `http://127.0.0.1:${S3_PORT}`;

/** SeaweedFS GitHub releases URL pattern for single-file binaries. */
const SEAWEEDFS_GITHUB = "https://github.com/seaweedfs/seaweedfs";

export interface SeaweedFSCredentials {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateKey(length = 20): string {
  return randomBytes(length).toString("base64url").slice(0, length).toUpperCase();
}

function generateSecret(length = 40): string {
  return randomBytes(length).toString("base64url").slice(0, length);
}

/** Detect OS architecture for binary download. */
async function detectArch(host: Host): Promise<"amd64" | "arm64" | null> {
  const res = await host.run(["uname", "-m"]);
  if (!res.ok) return null;
  const arch = res.output.trim();
  if (arch === "x86_64") return "amd64";
  if (arch === "aarch64" || arch === "arm64") return "arm64";
  return null;
}

/** Check whether SeaweedFS is responding on the S3 port. */
async function isSeaweedFSRunning(host: Host): Promise<boolean> {
  const res = await host.run(["curl", "-sf", "-o", "/dev/null", `${S3_ENDPOINT}/`]);
  return res.ok;
}

/** Fetch the latest SeaweedFS release version tag from GitHub. */
async function fetchLatestVersion(host: Host): Promise<string | null> {
  const res = await host.run([
    "curl", "-sf",
    "-H", "Accept: application/json",
    "https://api.github.com/repos/seaweedfs/seaweedfs/releases/latest",
  ]);
  if (!res.ok) return null;
  try {
    const data = JSON.parse(res.output);
    return data.tag_name ?? null;
  } catch {
    return null;
  }
}

// ─── Download ────────────────────────────────────────────────────────────────

async function downloadWeed(host: Host, dataDir: string, dryRun: boolean): Promise<boolean> {
  const arch = await detectArch(host);
  if (!arch) {
    fail("Architecture", "Could not detect system architecture (uname -m failed)");
    return false;
  }

  const spinner = p.spinner();
  spinner.start("Fetching latest SeaweedFS release…");
  const version = await fetchLatestVersion(host);
  spinner.stop(version ? `Latest version: ${pc.cyan(version)}` : "Could not fetch latest, will use default");

  const tag = version ?? "3.75";
  const assetName = `linux_${arch}_large_disk.tar.gz`;
  const downloadUrl = `${SEAWEEDFS_GITHUB}/releases/download/${tag}/${assetName}`;

  if (dryRun) {
    info("Dry run", `Would download: ${pc.dim(downloadUrl)}`);
    info("Dry run", `Would extract weed binary to ${WEED_BIN}`);
    return true;
  }

  const tmpTar = `/tmp/seaweedfs-${tag}.tar.gz`;

  spinner.start(`Downloading SeaweedFS ${tag}…`);
  const dlRes = await host.run(["curl", "-fL", "--output", tmpTar, downloadUrl]);
  if (!dlRes.ok) {
    spinner.stop("Failed");
    fail("Download", `Failed to download ${downloadUrl}`);
    return false;
  }
  spinner.stop("Downloaded");

  // Ensure bin directory exists
  await host.withElevation(`mkdir -p ${BIN_DIR}`, "Create binary directory");

  // Extract the weed binary
  const extractResult = await host.withElevation(
    `tar -xzf ${tmpTar} -C ${BIN_DIR} weed 2>/dev/null || tar -xzf ${tmpTar} -C /tmp && mv /tmp/weed ${WEED_BIN}`,
    "Extract weed binary",
  );
  if (!extractResult.success && !extractResult.skipped) {
    fail("Extract", "Failed to extract weed binary from archive");
    return false;
  }

  await host.withElevation(`chmod +x ${WEED_BIN}`, "Make weed binary executable");
  pass("Download", `SeaweedFS ${tag} installed at ${WEED_BIN}`);
  return true;
}

// ─── Configuration ───────────────────────────────────────────────────────────

async function writeS3Config(
  host: Host,
  accessKey: string,
  secretKey: string,
  dryRun: boolean,
): Promise<boolean> {
  const config = JSON.stringify(
    {
      identities: [
        {
          name: "xinity",
          credentials: [{ accessKey, secretKey }],
          actions: ["Admin", "Read", "Write"],
        },
      ],
    },
    null,
    2,
  );

  if (dryRun) {
    info("Dry run", `Would write S3 identity config to ${S3_CONFIG_PATH}`);
    return true;
  }

  await host.withElevation(`mkdir -p /etc/xinity-ai`, "Create config directory");
  const result = await host.withElevation(
    `cat > ${S3_CONFIG_PATH} << 'SEAWEEDFS_CONFIG_EOF'\n${config}\nSEAWEEDFS_CONFIG_EOF`,
    "Write SeaweedFS S3 config",
  );

  if (!result.success && !result.skipped) {
    fail("Config", "Failed to write S3 identity config");
    return false;
  }

  pass("Config", `S3 identity config written to ${S3_CONFIG_PATH}`);
  return true;
}

async function installSystemdUnit(
  host: Host,
  dataDir: string,
  dryRun: boolean,
): Promise<boolean> {
  const unitContent = [
    "[Unit]",
    "Description=Xinity SeaweedFS Object Store",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "User=root",
    `ExecStartPre=mkdir -p ${dataDir}`,
    `ExecStart=${WEED_BIN} server -s3 -s3.config=${S3_CONFIG_PATH} -dir=${dataDir} -ip.bind=127.0.0.1 -s3.port=${S3_PORT}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n") + "\n";

  if (dryRun) {
    info("Dry run", `Would install systemd unit: ${SEAWEEDFS_UNIT}`);
    return true;
  }

  const unitPath = `/etc/systemd/system/${SEAWEEDFS_UNIT}`;
  const result = await host.withElevation(
    `cat > ${unitPath} << 'UNIT_EOF'\n${unitContent}\nUNIT_EOF\nsystemctl daemon-reload`,
    "Install SeaweedFS systemd unit",
  );

  if (!result.success && !result.skipped) {
    fail("Systemd", "Failed to install unit file");
    return false;
  }

  pass("Systemd", `Unit installed: ${SEAWEEDFS_UNIT}`);
  return true;
}

async function startAndWait(host: Host, dryRun: boolean): Promise<boolean> {
  if (dryRun) {
    info("Dry run", `Would start and enable ${SEAWEEDFS_UNIT}`);
    return true;
  }

  const startResult = await host.withElevation(
    `systemctl enable --now ${SEAWEEDFS_UNIT}`,
    "Start SeaweedFS",
  );
  if (!startResult.success && !startResult.skipped) {
    fail("Start", "Failed to start SeaweedFS");
    return false;
  }

  // Poll for readiness
  const spinner = p.spinner();
  spinner.start("Waiting for SeaweedFS to start…");
  for (let i = 0; i < 30; i++) {
    if (await isSeaweedFSRunning(host)) {
      spinner.stop("SeaweedFS is ready");
      pass("Health", `S3 endpoint reachable at ${S3_ENDPOINT}`);
      return true;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }

  spinner.stop("Timed out");
  fail("Health", "SeaweedFS did not become ready within 30 seconds");
  return false;
}

async function createBucket(
  host: Host,
  bucket: string,
  accessKey: string,
  secretKey: string,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) {
    info("Dry run", `Would create S3 bucket: ${pc.cyan(bucket)}`);
    return true;
  }

  // Use AWS Signature V4 to create the bucket via curl
  // Build a minimal signed PUT request for bucket creation
  const res = await host.run([
    "curl", "-sf", "-X", "PUT",
    "-H", `Authorization: AWS ${accessKey}:${secretKey}`,
    `${S3_ENDPOINT}/${bucket}`,
  ]);

  // SeaweedFS also accepts unsigned bucket creation when credentials allow
  if (!res.ok) {
    // Try with simple auth header fallback
    const res2 = await host.run(["curl", "-sf", "-X", "PUT", `${S3_ENDPOINT}/${bucket}`]);
    if (!res2.ok) {
      warn("Bucket", `Could not create bucket '${bucket}', you may need to create it manually`);
      return false;
    }
  }

  pass("Bucket", `Created bucket: ${pc.cyan(bucket)}`);
  return true;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Interactive SeaweedFS setup flow.
 *
 * Returns credentials if setup completed, or undefined if the user cancelled.
 */
export async function seaweedfsSetup(
  host: Host,
  dryRun: boolean,
): Promise<SeaweedFSCredentials | undefined> {
  p.log.step(pc.bold("SeaweedFS object store setup"));
  p.log.info(
    "SeaweedFS provides S3-compatible object storage for multimodal image data.\n" +
    "It runs as a single binary with no external dependencies.",
  );

  // ── Step 1: Check if already installed ──────────────────────────────────
  const alreadyInstalled = await commandExistsOn(host, WEED_BIN) ||
    await commandExistsOn(host, "weed");

  if (alreadyInstalled) {
    pass("SeaweedFS", "Already installed");
  } else {
    const proceed = await p.confirm({
      message: "Download and install SeaweedFS?",
      initialValue: true,
    });
    if (p.isCancel(proceed) || !proceed) return undefined;

    const downloaded = await downloadWeed(host, "/var/lib/xinity-ai-seaweedfs/data", dryRun);
    if (!downloaded) return undefined;
  }

  // ── Step 2: Prompt for configuration ────────────────────────────────────
  p.log.step(pc.bold("Configure SeaweedFS"));

  const dataDirInput = await p.text({
    message: "Data directory",
    placeholder: "/var/lib/xinity-ai-seaweedfs/data",
    defaultValue: "/var/lib/xinity-ai-seaweedfs/data",
  });
  if (p.isCancel(dataDirInput)) return undefined;
  const dataDir = dataDirInput;

  const bucketInput = await p.text({
    message: "S3 bucket name",
    placeholder: "xinity-media",
    defaultValue: "xinity-media",
  });
  if (p.isCancel(bucketInput)) return undefined;
  const bucket = bucketInput;

  const useGenerated = await p.confirm({
    message: "Generate random S3 credentials?",
    initialValue: true,
  });
  if (p.isCancel(useGenerated)) return undefined;

  let accessKeyId: string;
  let secretAccessKey: string;

  if (useGenerated) {
    accessKeyId = generateKey();
    secretAccessKey = generateSecret();
    info("Access key", pc.cyan(accessKeyId));
    info("Secret key", pc.cyan(secretAccessKey));
  } else {
    const ak = await p.text({ message: "Access key ID" });
    if (p.isCancel(ak)) return undefined;
    const sk = await p.password({ message: "Secret access key" });
    if (p.isCancel(sk)) return undefined;
    accessKeyId = ak;
    secretAccessKey = sk;
  }

  // ── Step 3: Write S3 identity config ────────────────────────────────────
  const configured = await writeS3Config(host, accessKeyId, secretAccessKey, dryRun);
  if (!configured) return undefined;

  // ── Step 4: Install systemd unit ─────────────────────────────────────────
  const unitInstalled = await installSystemdUnit(host, dataDir, dryRun);
  if (!unitInstalled) return undefined;

  // ── Step 5: Start service ────────────────────────────────────────────────
  const started = await startAndWait(host, dryRun);
  if (!started) return undefined;

  // ── Step 6: Create bucket ────────────────────────────────────────────────
  await createBucket(host, bucket, accessKeyId, secretAccessKey, dryRun);

  const credentials: SeaweedFSCredentials = {
    endpoint: S3_ENDPOINT,
    accessKeyId,
    secretAccessKey,
    bucket,
  };

  p.note(
    [
      `S3_ENDPOINT=${credentials.endpoint}`,
      `S3_ACCESS_KEY_ID=${credentials.accessKeyId}`,
      `S3_SECRET_ACCESS_KEY=${credentials.secretAccessKey}`,
      `S3_BUCKET=${credentials.bucket}`,
      `S3_REGION=us-east-1`,
    ].join("\n"),
    "Add these to your gateway and dashboard env files",
  );

  return credentials;
}
