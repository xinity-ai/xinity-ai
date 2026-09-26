/**
 * `xinity up infra-seaweedfs`: a single-node SeaweedFS giving the multimodal
 * image store an S3-compatible endpoint. Not a compose stack, so it runs as a
 * downloaded binary under systemd rather than a container.
 *
 * All shell operations go through the Host interface so this works identically
 * for local and remote (--target-host) execution.
 */
import { confirm, isCancel, log, note, password, spinner as clackSpinner, text } from "./clack.ts";
import { bold, cyan, dim } from "picocolors";
import { type Host, commandExistsOn } from "./host.ts";
import { pass, fail, info, promptOrUndefined, warn } from "./output.ts";
import { heredoc } from "./service.ts";
import { waitForReady } from "./compose-service.ts";
import { BIN_DIR, ENV_DIR, UNIT_DIR } from "./component-meta.ts";
import { generateUnit } from "./systemd.ts";
import { randomToken } from "./secrets.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const WEED_BIN = `${BIN_DIR}/weed`;
const SEAWEEDFS_UNIT = "xinity-ai-seaweedfs.service";
const UNIT_PATH = `${UNIT_DIR}/${SEAWEEDFS_UNIT}`;
const S3_CONFIG_PATH = `${ENV_DIR}/seaweedfs-s3.json`;
const S3_PORT = 8333;
const S3_ENDPOINT = `http://127.0.0.1:${S3_PORT}`;
const DEFAULT_DATA_DIR = "/var/lib/xinity-ai-seaweedfs/data";

const SEAWEEDFS_GITHUB = "https://github.com/seaweedfs/seaweedfs";
const FALLBACK_VERSION = "3.75";

export type SeaweedFSCredentials = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

// ─── Probes ──────────────────────────────────────────────────────────────────

async function detectArch(host: Host): Promise<"amd64" | "arm64" | null> {
  const res = await host.run(["uname", "-m"]);
  if (!res.ok) return null;
  const arch = res.output.trim();
  if (arch === "x86_64") return "amd64";
  if (arch === "aarch64" || arch === "arm64") return "arm64";
  return null;
}

async function isSeaweedFSRunning(host: Host): Promise<boolean> {
  const res = await host.run(["curl", "-sf", "-o", "/dev/null", `${S3_ENDPOINT}/`]);
  return res.ok;
}

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

// ─── Config generation ───────────────────────────────────────────────────────

function buildS3Config(accessKey: string, secretKey: string): string {
  return JSON.stringify(
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
}

function buildUnitFile(dataDir: string): string {
  return generateUnit({
    component: "seaweedfs",
    description: "Xinity SeaweedFS Object Store",
    execStart: `${WEED_BIN} server -s3 -s3.config=${S3_CONFIG_PATH} -dir=${dataDir} -ip.bind=127.0.0.1 -s3.port=${S3_PORT}`,
    secretKeys: [],
    environmentFile: null,
    // The data dir is root-owned, so switching to DynamicUser would strand it.
    runAsRoot: true,
    hardened: true,
    readWritePaths: [dataDir],
  });
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export type SeaweedfsDownload = {
  version: string;
  url: string;
  tmpTar: string;
}

export type SeaweedfsPlan = {
  download?: SeaweedfsDownload;
  dataDir: string;
  credentials: SeaweedFSCredentials;
  s3Config: string;
  unitFile: string;
}

async function promptOrGenerateS3Credentials(): Promise<{ accessKeyId: string; secretAccessKey: string } | undefined> {
  const useGenerated = await promptOrUndefined(confirm({
    message: "Generate random S3 credentials?",
    initialValue: true,
  }));
  if (useGenerated === undefined) return undefined;

  if (useGenerated) {
    const accessKeyId = randomToken(20).toUpperCase();
    const secretAccessKey = randomToken();
    info("Access key", cyan(accessKeyId));
    info("Secret key", cyan(secretAccessKey));
    return { accessKeyId, secretAccessKey };
  }

  const accessKeyId = await promptOrUndefined(text({ message: "Access key ID" }));
  if (accessKeyId === undefined) return undefined;
  const secretAccessKey = await promptOrUndefined(password({ message: "Secret access key" }));
  if (secretAccessKey === undefined) return undefined;
  return { accessKeyId, secretAccessKey };
}

async function planDownload(host: Host): Promise<SeaweedfsDownload | undefined> {
  const arch = await detectArch(host);
  if (!arch) {
    fail("Architecture", "Could not detect system architecture (uname -m failed)");
    return undefined;
  }

  const spinner = clackSpinner();
  spinner.start("Fetching latest SeaweedFS release…");
  const version = await fetchLatestVersion(host);
  spinner.stop(version ? `Latest version: ${cyan(version)}` : "Could not fetch latest, will use default");

  const tag = version ?? FALLBACK_VERSION;
  return {
    version: tag,
    url: `${SEAWEEDFS_GITHUB}/releases/download/${tag}/linux_${arch}_large_disk.tar.gz`,
    tmpTar: `/tmp/seaweedfs-${tag}.tar.gz`,
  };
}

export async function planSeaweedfs(host: Host): Promise<SeaweedfsPlan | undefined> {
  const alreadyInstalled = await commandExistsOn(host, WEED_BIN) ||
    await commandExistsOn(host, "weed");

  let download: SeaweedfsDownload | undefined;
  if (alreadyInstalled) {
    pass("SeaweedFS", "Already installed");
  } else {
    const proceed = await confirm({
      message: "Download and install SeaweedFS?",
      initialValue: true,
    });
    if (isCancel(proceed) || !proceed) return undefined;

    download = await planDownload(host);
    if (!download) return undefined;
  }

  log.step(bold("Configure SeaweedFS"));

  const dataDir = await promptOrUndefined(text({
    message: "Data directory",
    placeholder: DEFAULT_DATA_DIR,
    defaultValue: DEFAULT_DATA_DIR,
  }));
  if (dataDir === undefined) return undefined;

  const bucket = await promptOrUndefined(text({
    message: "S3 bucket name",
    placeholder: "xinity-media",
    defaultValue: "xinity-media",
  }));
  if (bucket === undefined) return undefined;

  const keyPair = await promptOrGenerateS3Credentials();
  if (!keyPair) return undefined;

  return {
    download,
    dataDir,
    credentials: { endpoint: S3_ENDPOINT, bucket, ...keyPair },
    s3Config: buildS3Config(keyPair.accessKeyId, keyPair.secretAccessKey),
    unitFile: buildUnitFile(dataDir),
  };
}

export function buildSeaweedfsCommands(plan: SeaweedfsPlan): string[] {
  const commands: string[] = [];

  if (plan.download) {
    const { url, tmpTar } = plan.download;
    commands.push(
      `curl -fL --output ${tmpTar} ${url}`,
      `mkdir -p ${BIN_DIR}`,
      extractCommand(tmpTar),
      `chmod +x ${WEED_BIN}`,
    );
  }

  commands.push(
    `mkdir -p ${ENV_DIR}`,
    `cat > ${S3_CONFIG_PATH} ${heredoc("SEAWEEDFS_CONFIG_EOF", plan.s3Config)}`,
    `mkdir -p ${plan.dataDir}`,
    `cat > ${UNIT_PATH} ${heredoc("UNIT_EOF", plan.unitFile)}`,
    "systemctl daemon-reload",
    `systemctl enable --now ${SEAWEEDFS_UNIT}`,
    bucketArgs(plan.credentials).join(" "),
  );

  return commands;
}

function extractCommand(tmpTar: string): string {
  return `tar -xzf ${tmpTar} -C ${BIN_DIR} weed 2>/dev/null || tar -xzf ${tmpTar} -C /tmp && mv /tmp/weed ${WEED_BIN}`;
}

function bucketArgs(creds: SeaweedFSCredentials): string[] {
  return [
    "curl", "-sf", "-X", "PUT",
    "-H", `Authorization: AWS ${creds.accessKeyId}:${creds.secretAccessKey}`,
    `${S3_ENDPOINT}/${creds.bucket}`,
  ];
}

// ─── Apply ───────────────────────────────────────────────────────────────────

async function downloadWeed(host: Host, download: SeaweedfsDownload): Promise<boolean> {
  const spinner = clackSpinner();
  spinner.start(`Downloading SeaweedFS ${download.version}…`);
  const dlRes = await host.run(["curl", "-fL", "--output", download.tmpTar, download.url]);
  if (!dlRes.ok) {
    spinner.stop("Failed");
    fail("Download", `Failed to download ${download.url}`);
    return false;
  }
  spinner.stop("Downloaded");

  await host.withElevation(`mkdir -p ${BIN_DIR}`, "Create binary directory");
  const extracted = await host.withElevation(extractCommand(download.tmpTar), "Extract weed binary");
  if (!extracted.success) {
    fail("Extract", "Failed to extract weed binary from archive");
    return false;
  }

  await host.withElevation(`chmod +x ${WEED_BIN}`, "Make weed binary executable");
  pass("Download", `SeaweedFS ${download.version} installed at ${WEED_BIN}`);
  return true;
}

async function writeS3Config(host: Host, s3Config: string): Promise<boolean> {
  await host.withElevation(`mkdir -p ${ENV_DIR}`, "Create config directory");
  const result = await host.withElevation(
    `cat > ${S3_CONFIG_PATH} ${heredoc("SEAWEEDFS_CONFIG_EOF", s3Config)}`,
    "Write SeaweedFS S3 config",
  );
  if (!result.success) {
    fail("Config", "Failed to write S3 identity config");
    return false;
  }
  pass("Config", `S3 identity config written to ${S3_CONFIG_PATH}`);
  return true;
}

async function installSystemdUnit(host: Host, plan: SeaweedfsPlan): Promise<boolean> {
  // ReadWritePaths refuses to start the unit if the data dir does not exist yet.
  const result = await host.withElevation(
    `mkdir -p ${plan.dataDir}\ncat > ${UNIT_PATH} ${heredoc("UNIT_EOF", plan.unitFile)}\nsystemctl daemon-reload`,
    "Install SeaweedFS systemd unit",
  );
  if (!result.success) {
    fail("Systemd", "Failed to install unit file");
    return false;
  }
  pass("Systemd", `Unit installed: ${SEAWEEDFS_UNIT}`);
  return true;
}

async function startAndWait(host: Host): Promise<boolean> {
  const startResult = await host.withElevation(
    `systemctl enable --now ${SEAWEEDFS_UNIT}`,
    "Start SeaweedFS",
  );
  if (!startResult.success) {
    fail("Start", "Failed to start SeaweedFS");
    return false;
  }

  const spinner = clackSpinner();
  spinner.start("Waiting for SeaweedFS to start…");
  if (!(await waitForReady(() => isSeaweedFSRunning(host)))) {
    spinner.stop("Timed out");
    fail("Health", "SeaweedFS did not become ready within 30 seconds");
    return false;
  }
  spinner.stop("SeaweedFS is ready");
  pass("Health", `S3 endpoint reachable at ${S3_ENDPOINT}`);
  return true;
}

async function createBucket(host: Host, creds: SeaweedFSCredentials): Promise<void> {
  const signed = await host.run(bucketArgs(creds));
  if (signed.ok) {
    pass("Bucket", `Created bucket: ${cyan(creds.bucket)}`);
    return;
  }

  // SeaweedFS also accepts unsigned bucket creation when the identity allows it.
  const unsigned = await host.run(["curl", "-sf", "-X", "PUT", `${S3_ENDPOINT}/${creds.bucket}`]);
  if (unsigned.ok) {
    pass("Bucket", `Created bucket: ${cyan(creds.bucket)}`);
    return;
  }
  warn("Bucket", `Could not create bucket '${creds.bucket}', you may need to create it manually`);
}

export async function applySeaweedfs(plan: SeaweedfsPlan, host: Host): Promise<boolean> {
  if (plan.download && !(await downloadWeed(host, plan.download))) return false;
  if (!(await writeS3Config(host, plan.s3Config))) return false;
  if (!(await installSystemdUnit(host, plan))) return false;
  if (!(await startAndWait(host))) return false;
  await createBucket(host, plan.credentials);
  return true;
}

// ─── Main entry point ────────────────────────────────────────────────────────

function credentialLines(creds: SeaweedFSCredentials): string {
  return [
    `S3_ENDPOINT=${creds.endpoint}`,
    `S3_ACCESS_KEY_ID=${creds.accessKeyId}`,
    `S3_SECRET_ACCESS_KEY=${creds.secretAccessKey}`,
    `S3_BUCKET=${creds.bucket}`,
    `S3_REGION=us-east-1`,
  ].join("\n");
}

export async function seaweedfsSetup(
  host: Host,
  dryRun: boolean,
): Promise<SeaweedFSCredentials | undefined> {
  log.step(bold("SeaweedFS object store setup"));
  log.info(
    "SeaweedFS provides S3-compatible object storage for multimodal image data.\n" +
    "It runs as a single binary with no external dependencies.",
  );

  const plan = await planSeaweedfs(host);
  if (!plan) return undefined;

  if (dryRun) {
    for (const cmd of buildSeaweedfsCommands(plan)) {
      info("Dry run", `Would run: ${dim(cmd.split("\n")[0] ?? cmd)}`);
    }
    note(credentialLines(plan.credentials), "S3 credentials (not yet created)");
    return plan.credentials;
  }

  if (!(await applySeaweedfs(plan, host))) return undefined;
  note(credentialLines(plan.credentials), "Add these to your gateway and dashboard env files");
  return plan.credentials;
}
