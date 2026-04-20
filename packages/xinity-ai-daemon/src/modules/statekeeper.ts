import { getDB } from "../db/connection";
import { aiNodeT, eq, sql } from "common-db";
import { getTlsConfig } from "common-env";
import { $ } from "bun";
import { env } from "../env";
import { join } from "path";
import { networkInterfaces } from "node:os";
import { detectHardwareProfile, type HardwareProfile } from "./hardware-detect";
import { normalizePep440 } from "xinity-infoserver";
import { rootLogger } from "../logger";

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
      { gpuCount: cachedProfile.gpuCount, capacityGb: cachedProfile.detectedCapacityGb, source: cachedProfile.source },
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

/** Detects driver versions from configured endpoints/binaries. Best-effort: missing = empty. */
export async function getNodeDriverVersions(): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};

  if (env.XINITY_OLLAMA_ENDPOINT) {
    try {
      const res = await fetch(`${env.XINITY_OLLAMA_ENDPOINT}/api/version`);
      if (res.ok) {
        const data = await res.json() as { version?: string };
        if (data.version) versions["ollama"] = data.version;
      }
    } catch (err) {
      log.debug({ err }, "Failed to detect Ollama version");
    }
  }

  if (env.VLLM_DOCKER_IMAGE) {
    try {
      const output = await $`docker run --rm --entrypoint vllm ${env.VLLM_DOCKER_IMAGE} version`
        .throws(false).text();
      const match = output.match(/(\d+\.\d+\.\d+\S*)/);
      if (match) versions["vllm"] = normalizePep440(match[1]);
    } catch (err) {
      log.debug({ err }, "Failed to detect vLLM Docker version");
    }
  } else if (env.VLLM_PATH) {
    try {
      const output = await $`${env.VLLM_PATH} version`.throws(false).text();
      const match = output.match(/(\d+\.\d+\.\d+\S*)/);
      if (match) versions["vllm"] = normalizePep440(match[1]);
    } catch (err) {
      log.debug({ err }, "Failed to detect vLLM version");
    }
  }

  return versions;
}

/** Retrieves the nodeID of this ai node. If it is not recorded in the database yet, it will be created */
export async function getNodeId(){
  if (cachedNodeId) return cachedNodeId;

  const idFile = Bun.file(join(env.STATE_DIR, "node_id"));
  if(!await idFile.exists()){
    const host = Object.values(networkInterfaces())
      .flatMap(n => n ?? [])
      .find(n =>  n.family === 'IPv4' &&
          (!n.cidr || n.cidr.startsWith(env.CIDR_PREFIX)) &&
          !n.internal
        )?.address || '127.0.0.1';

    const driverVersions = getNodeDriverVersions();
    const { detectedCapacityGb, gpuCount, gpus: detectedGpus } = await getHardwareProfile();
    const gpus = detectedGpus.map(g => ({ vendor: g.vendor, name: g.name, vramMb: g.vramMb }));
    const tls = getTlsConfig(env);

    const [row] = await getDB().insert(aiNodeT).values({
      estCapacity: detectedCapacityGb,
      gpuCount,
      host,
      port: env.PORT,
      available: true,
      drivers: getNodeDrivers(),
      driverVersions: await driverVersions,
      gpus,
      authToken,
      tls: !!tls,
    }).onConflictDoUpdate({
      target: [aiNodeT.host, aiNodeT.port],
      targetWhere: sql`${aiNodeT.deletedAt} IS NULL`,
      set: {
        estCapacity: detectedCapacityGb,
        gpuCount,
        available: true,
        drivers: getNodeDrivers(),
        driverVersions: await driverVersions,
        gpus,
        authToken,
        tls: !!getTlsConfig(env),
      },
    }).returning({id: aiNodeT.id});

    idFile.write(row.id);
    cachedNodeId = row.id;
    return cachedNodeId;
  }

  cachedNodeId = (await idFile.text()).trim();
  return cachedNodeId;
}

/** Sets the node to available, and updates driver capabilities and hardware profile */
export async function setOnline(){
  const nodeId = await getNodeId();
  const { detectedCapacityGb, gpuCount, gpus: detectedGpus } = await getHardwareProfile();
  const driverVersions = await getNodeDriverVersions();
  const gpus = detectedGpus.map(g => ({ vendor: g.vendor, name: g.name, vramMb: g.vramMb }));

  await getDB()
    .update(aiNodeT)
    .set({
      available: true,
      port: env.PORT,
      tls: !!getTlsConfig(env),
      drivers: getNodeDrivers(),
      driverVersions,
      gpus,
      estCapacity: detectedCapacityGb,
      gpuCount,
      authToken,
    })
    .where(eq(aiNodeT.id, nodeId));
}

export async function setOffline(){
  const nodeId = await getNodeId();

  await getDB()
    .update(aiNodeT)
    .set({available: false})
    .where(eq(aiNodeT.id, nodeId));

}
