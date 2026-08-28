import { getTlsConfig, protocolFingerprint } from "common-env";
import { $ } from "bun";
import { env } from "../env";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { detectHardwareProfile, detectNodeName, type HardwareProfile } from "./hardware-detect";
import { normalizePep440 } from "xinity-infoserver";
import { rootLogger } from "../logger";
import { detectVllmFeatures, resolvePythonForVllm } from "./vllm-features";
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

/** Ollama needs no configuration, so its driver is derived from a live probe rather than from env. */
export async function getNodeDrivers(): Promise<string[]> {
  const drivers: string[] = [];
  if (await detectOllamaVersion(env.OLLAMA_URL)) {
    drivers.push("ollama");
  }
  if (env.VLLM_DOCKER_IMAGE || env.VLLM_PATH) {
    drivers.push("vllm");
  }
  return drivers;
}

/** Reads the installed distribution's version without importing vllm itself. */
const VLLM_VERSION_FROM_METADATA = "from importlib.metadata import version; print(version('vllm'))";

type VersionProbe = {
  label: string;
  run: () => Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }>;
}

/** Probes are tried in order; the first one that yields a version wins. */
async function detectVllmVersion(
  source: "docker" | "binary",
  probes: VersionProbe[],
): Promise<string | undefined> {
  let last: Record<string, unknown> | undefined;
  for (const probe of probes) {
    try {
      const { stdout, stderr, exitCode } = await probe.run();
      const output = stdout.toString();
      const version = output.match(/(\d+\.\d+\.\d+\S*)/)?.[1];
      if (version) {
        return normalizePep440(version);
      }
      last = { probe: probe.label, exitCode, stdout: output, stderr: stderr.toString() };
    } catch (err) {
      log.debug({ err, source, probe: probe.label }, "vLLM version probe failed");
    }
  }
  if (last) {
    log.warn({ source, ...last }, "Could not read the vLLM version");
  }
  return undefined;
}

/** Bounded so an unreachable or wedged endpoint cannot stall registration or a sync cycle. */
const OLLAMA_PROBE_TIMEOUT_MS = 3_000;

async function detectOllamaVersion(endpoint: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${endpoint}/api/version`, { signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS) });
    if (!res.ok) {
      return undefined;
    }
    const data = await res.json() as { version?: string };
    return data.version;
  } catch (err) {
    log.debug({ err, endpoint }, "Ollama did not answer, treating the driver as unavailable");
    return undefined;
  }
}

async function detectConfiguredVllmVersion(): Promise<string | undefined> {
  const image = env.VLLM_DOCKER_IMAGE;
  if (image) {
    return detectVllmVersion("docker", [
      { label: "metadata", run: () => $`docker run --rm --entrypoint python3 ${image} -c ${VLLM_VERSION_FROM_METADATA}`.throws(false).quiet() },
      { label: "cli", run: () => $`docker run --rm --gpus all --entrypoint ${env.VLLM_PATH ?? "vllm"} ${image} --version`.throws(false).quiet() },
    ]);
  }
  const vllmPath = env.VLLM_PATH;
  if (vllmPath) {
    const pythonBin = await resolvePythonForVllm(vllmPath);
    return detectVllmVersion("binary", [
      { label: "metadata", run: () => $`${pythonBin} -c ${VLLM_VERSION_FROM_METADATA}`.throws(false).quiet() },
      { label: "cli", run: () => $`${vllmPath} --version`.throws(false).quiet() },
    ]);
  }
  return undefined;
}

/** Detects driver versions from configured endpoints/binaries. Best-effort: missing = empty. */
export async function getNodeDriverVersions(): Promise<Record<string, string>> {
  const [ollama, vllm] = await Promise.all([
    detectOllamaVersion(env.OLLAMA_URL),
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
