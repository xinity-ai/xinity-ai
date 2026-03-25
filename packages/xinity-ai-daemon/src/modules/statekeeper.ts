import { getDB } from "../db/connection";
import { aiNodeT, eq, sql } from "common-db";
import { env } from "../env";
import { join } from "path";
import { networkInterfaces } from "node:os";
import { detectHardwareProfile, type HardwareProfile } from "./hardware-detect";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "statekeeper" });

let cachedProfile: HardwareProfile | null = null;

async function getHardwareProfile(): Promise<HardwareProfile> {
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

/** Retrieves the nodeID of this ai node. If it is not recorded in the database yet, it will be created */
export async function getNodeId(){
  const idFile = Bun.file(join(env.STATE_DIR, "node_id"));
  if(!await idFile.exists()){
    const host = Object.values(networkInterfaces())
      .flatMap(n => n ?? [])
      .find(n =>  n.family === 'IPv4' &&
          (!n.cidr || n.cidr.startsWith(env.CIDR_PREFIX)) &&
          !n.internal
        )?.address || '127.0.0.1';

    const { detectedCapacityGb, gpuCount } = await getHardwareProfile();

    const [row] = await getDB().insert(aiNodeT).values({
      estCapacity: detectedCapacityGb,
      gpuCount,
      host,
      port: 11434,
      available: true,
      drivers: getNodeDrivers(),
    }).onConflictDoUpdate({
      target: [aiNodeT.host, aiNodeT.port],
      targetWhere: sql`${aiNodeT.deletedAt} IS NULL`,
      set: {
        estCapacity: detectedCapacityGb,
        gpuCount,
        available: true,
        drivers: getNodeDrivers(),
      },
    }).returning({id: aiNodeT.id});
    const id = row.id;

    idFile.write(id);
    return id;
  }
  return idFile.text();
}

/** Sets the node to available, and updates driver capabilities and hardware profile */
export async function setOnline(){
  const nodeId = await getNodeId();
  const { detectedCapacityGb, gpuCount } = await getHardwareProfile();

  await getDB()
    .update(aiNodeT)
    .set({
      available: true,
      drivers: getNodeDrivers(),
      estCapacity: detectedCapacityGb,
      gpuCount,
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
