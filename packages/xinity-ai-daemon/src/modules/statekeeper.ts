import { getTlsConfig, protocolFingerprint } from "common-env";
import { $ } from "bun";
import { env } from "../env";
import { join } from "path";
import { networkInterfaces } from "node:os";
import { detectHardwareProfile, detectNodeName, type HardwareProfile } from "./hardware-detect";
import { normalizePep440 } from "xinity-infoserver";
import { rootLogger } from "../logger";
import { detectVllmFeatures } from "./vllm-features";
import type { NodeRegistration } from "common-env";

const log = rootLogger.child({ name: "statekeeper" });

let cachedProfile: HardwareProfile | null = null;
let cachedNodeId: string | null = null;
let cachedMachineName: string | null = null;
const authToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** Returns the auth token generated for this daemon instance. */
export function getAuthToken() {
  return authToken;
}

/** Returns the machine name (MACHINE_NAME env or OS hostname). */
export function getMachineName(): string {
  if (!cachedMachineName) {
    cachedMachineName = detectNodeName(env.MACHINE_NAME);
  }
  return cachedMachineName;
}

export async function getHardwareProfile(): Promise<HardwareProfile> {
  if (!cachedProfile) {
    cachedProfile = await detectHardwareProfile();
    log.info(
      { gpuCount: cachedProfile.gpuCount, detectedCapacityGb: cachedProfile.detectedCapacityGb, physicalCapacityGb: cachedProfile.physicalCapacityGb, source: cachedProfile.source },
      "Hardware profile detected",
    );
  }
  return cachedProfile;
}

/** Derives supported drivers from configured environment variables. */
export function getNodeDrivers(): string[] {
  const drivers: string[] = [];
  if (env.XINITY_OLLAMA_ENDPOINT) {
    drivers.push("ollama");
  }
  if (env.VLLM_DOCKER_IMAGE || env.VLLM_PATH) {
    drivers.push("vllm");
  }
  return drivers;
}

async function detectVllmVersion(
  source: "docker" | "binary",
  runVersionCommand: () => Promise<string>,
): Promise<string | undefined> {
  try {
    const output = await runVersionCommand();
    const version = output.match(/(\d+\.\d+\.\d+\S*)/)?.[1];
    if (version) {
      return normalizePep440(version);
    }
    log.warn({ output, source }, "vLLM version output did not match expected format");
  } catch (err) {
    log.debug({ err, source }, "Failed to detect vLLM version");
  }
  return undefined;
}

async function detectOllamaVersion(endpoint: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${endpoint}/api/version`);
    if (!res.ok) {
      return undefined;
    }
    const data = await res.json() as { version?: string };
    return data.version;
  } catch (err) {
    log.debug({ err }, "Failed to detect Ollama version");
    return undefined;
  }
}

async function detectConfiguredOllamaVersion(): Promise<string | undefined> {
  if (!env.XINITY_OLLAMA_ENDPOINT) {
    return undefined;
  }
  return detectOllamaVersion(env.XINITY_OLLAMA_ENDPOINT);
}

async function detectConfiguredVllmVersion(): Promise<string | undefined> {
  if (env.VLLM_DOCKER_IMAGE) {
    return detectVllmVersion("docker", () =>
      $`docker run --rm --gpus all --entrypoint ${env.VLLM_PATH ?? "vllm"} ${env.VLLM_DOCKER_IMAGE} --version`.throws(false).text(),
    );
  }
  if (env.VLLM_PATH) {
    return detectVllmVersion("binary", () =>
      $`${env.VLLM_PATH} --version`.throws(false).text(),
    );
  }
  return undefined;
}

/** Detects driver versions from configured endpoints/binaries. Best-effort: missing = empty. */
export async function getNodeDriverVersions(): Promise<Record<string, string>> {
  const [ollama, vllm] = await Promise.all([
    detectConfiguredOllamaVersion(),
    detectConfiguredVllmVersion(),
  ]);

  const versions: Record<string, string> = {};
  if (ollama) {
    versions["ollama"] = ollama;
  }
  if (vllm) {
    versions["vllm"] = vllm;
  }
  return versions;
}

export async function getNodeDriverFeatures(): Promise<Record<string, string[]>> {
  const features: Record<string, string[]> = {};
  try {
    if (env.VLLM_DOCKER_IMAGE || env.VLLM_PATH) {
      const source: "docker" | "binary" = env.VLLM_DOCKER_IMAGE ? "docker" : "binary";
      features["vllm"] = await detectVllmFeatures(source, {
        dockerImage: env.VLLM_DOCKER_IMAGE,
        vllmPath: env.VLLM_PATH,
      });
    }
  } catch (err) {
    log.warn({ err }, "Driver feature detection failed, continuing without features");
  }
  return features;
}

function findHostIPv4Address(): string {
  const isMatchingExternalIPv4 = (iface: { family: string; cidr?: string | null; internal: boolean }) =>
    iface.family === 'IPv4' &&
    (!iface.cidr || iface.cidr.startsWith(env.CIDR_PREFIX)) &&
    !iface.internal;

  const match = Object.values(networkInterfaces())
    .flatMap(n => n ?? [])
    .find(isMatchingExternalIPv4);
  return match?.address || '127.0.0.1';
}

/** Reads the persisted node id from STATE_DIR, or null if it has not been written yet. */
export async function readNodeIdFile(): Promise<string | null> {
  const idFile = Bun.file(join(env.STATE_DIR, "node_id"));
  if (!(await idFile.exists())) {
    return null;
  }
  const id = (await idFile.text()).trim();
  return id.length > 0 ? id : null;
}

async function writeNodeIdFile(id: string): Promise<void> {
  await Bun.file(join(env.STATE_DIR, "node_id")).write(id);
}

async function collectRegistrationData(): Promise<NodeRegistration> {
  const { detectedCapacityGb, gpuCount, gpus: detectedGpus } = await getHardwareProfile();
  const [driverVersions, driverFeatures] = await Promise.all([
    getNodeDriverVersions(),
    getNodeDriverFeatures(),
  ]);
  const machineName = detectNodeName(env.MACHINE_NAME);
  const host = findHostIPv4Address();
  const port = env.PORT;

  let id = await readNodeIdFile();
  if (!id) {
    id = crypto.randomUUID();
    await writeNodeIdFile(id);
  }

  cachedNodeId = id;

  return {
    nodeId: id,
    host,
    port,
    gpuCount,
    gpus: detectedGpus.map(g => ({ vendor: g.vendor, name: g.name, vramMb: g.vramMb })),
    driverVersions,
    driverFeatures,
    tls: !!getTlsConfig(env),
    estCapacity: detectedCapacityGb,
    machineName,
    authToken,
    protocolFingerprint: protocolFingerprint(),
  };
}

export async function getNodeId(): Promise<string> {
  if (cachedNodeId) {
    return cachedNodeId;
  }
  const reg = await collectRegistrationData();
  return reg.nodeId;
}

/** Collects hardware profile and builds the registration payload for the tether SSE handshake. */
export async function buildRegistration(): Promise<NodeRegistration> {
  return collectRegistrationData();
}
