import { getDB } from "../db/connection";
import { aiNodeT, eq, sql } from "common-db";
import { getTlsConfig } from "common-env";
import { $ } from "bun";
import { env } from "../env";
import { join } from "path";
import { networkInterfaces } from "node:os";
import { detectHardwareProfile, detectNodeName, type HardwareProfile } from "./hardware-detect";
import { normalizePep440 } from "xinity-infoserver";
import { rootLogger } from "../logger";
import { reportStatus } from "./conductor-client";

const log = rootLogger.child({ name: "statekeeper" });

let cachedProfile: HardwareProfile | null = null;
let cachedNodeId: string | null = null;
const authToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** Returns the auth token generated for this daemon instance. */
export function getAuthToken() {
  return authToken;
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
  if (env.XINITY_OLLAMA_ENDPOINT) drivers.push("ollama");
  if (env.VLLM_DOCKER_IMAGE || env.VLLM_PATH) drivers.push("vllm");
  return drivers;
}

async function detectVllmVersion(
  source: "docker" | "binary",
  runVersionCommand: () => Promise<string>,
): Promise<string | undefined> {
  try {
    const output = await runVersionCommand();
    const match = output.match(/(\d+\.\d+\.\d+\S*)/);
    if (match) return normalizePep440(match[1]);
    log.warn({ output, source }, "vLLM version output did not match expected format");
  } catch (err) {
    log.debug({ err, source }, "Failed to detect vLLM version");
  }
  return undefined;
}

async function detectOllamaVersion(endpoint: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${endpoint}/api/version`);
    if (!res.ok) return undefined;
    const data = await res.json() as { version?: string };
    return data.version;
  } catch (err) {
    log.debug({ err }, "Failed to detect Ollama version");
    return undefined;
  }
}

async function detectConfiguredOllamaVersion(): Promise<string | undefined> {
  if (!env.XINITY_OLLAMA_ENDPOINT) return undefined;
  return detectOllamaVersion(env.XINITY_OLLAMA_ENDPOINT);
}

async function detectConfiguredVllmVersion(): Promise<string | undefined> {
  if (env.VLLM_DOCKER_IMAGE) {
    return detectVllmVersion("docker", () =>
      $`docker run --rm --gpus all --entrypoint vllm ${env.VLLM_DOCKER_IMAGE} --version`.throws(false).text(),
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
  if (ollama) versions["ollama"] = ollama;
  if (vllm) versions["vllm"] = vllm;
  return versions;
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

async function collectNodeRuntimeState() {
  const { detectedCapacityGb, gpuCount, gpus: detectedGpus } = await getHardwareProfile();
  const [driverVersions] = await Promise.all([
    getNodeDriverVersions(),
  ]);
  const machineName = detectNodeName(env.MACHINE_NAME);
  return {
    estCapacity: detectedCapacityGb,
    gpuCount,
    drivers: getNodeDrivers(),
    driverVersions,
    gpus: detectedGpus.map(g => ({ vendor: g.vendor, name: g.name, vramMb: g.vramMb })),
    machineName,
    authToken,
    tls: !!getTlsConfig(env),
  };
}

/** Retrieves the nodeID of this ai node. If it is not recorded in the database yet, it will be created */
export async function getNodeId(){
  if (cachedNodeId) return cachedNodeId;

  const idFile = Bun.file(join(env.STATE_DIR, "node_id"));
  if(!await idFile.exists()){
    const runtimeState = await collectNodeRuntimeState();
    const [row] = await getDB().insert(aiNodeT).values({
      ...runtimeState,
      host: findHostIPv4Address(),
      port: env.PORT,
      available: true,
    }).onConflictDoUpdate({
      target: [aiNodeT.host, aiNodeT.port],
      targetWhere: sql`${aiNodeT.deletedAt} IS NULL`,
      set: { ...runtimeState, available: true },
    }).returning({id: aiNodeT.id});

    await idFile.write(row.id);
    cachedNodeId = row.id;
    return cachedNodeId;
  }

  cachedNodeId = (await idFile.text()).trim();
  return cachedNodeId;
}

/** Sets the node to available, and updates driver capabilities and hardware profile */
export async function setOnline(){
  const nodeId = await getNodeId();
  const runtimeState = await collectNodeRuntimeState();

  await getDB()
    .update(aiNodeT)
    .set({
      ...runtimeState,
      available: true,
      port: env.PORT,
    })
    .where(eq(aiNodeT.id, nodeId));

  const [row] = await getDB().select({ host: aiNodeT.host }).from(aiNodeT).where(eq(aiNodeT.id, nodeId)).limit(1);
  void reportStatus({
    nodeId,
    registration: {
      host: row?.host ?? "127.0.0.1",
      port: env.PORT,
      estCapacity: runtimeState.estCapacity,
      drivers: runtimeState.drivers,
      driverVersions: runtimeState.driverVersions,
      gpuCount: runtimeState.gpuCount,
      gpus: runtimeState.gpus,
      tls: runtimeState.tls,
    },
    installations: [],
  });
}

export async function setOffline(){
  const nodeId = await getNodeId();

  await getDB()
    .update(aiNodeT)
    .set({ available: false, authToken: null })
    .where(eq(aiNodeT.id, nodeId));

}
