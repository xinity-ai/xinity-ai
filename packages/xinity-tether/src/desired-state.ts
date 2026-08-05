import { modelInstallationT, sql } from "common-db";
import { getDB } from "./db";
import type { DesiredState } from "common-env";

export async function buildDesiredState(nodeId: string): Promise<DesiredState> {
  const rows = await getDB()
    .select()
    .from(modelInstallationT)
    .where(sql`${modelInstallationT.nodeId} = ${nodeId} AND ${modelInstallationT.deletedAt} IS NULL`);

  return {
    nodeId,
    installations: rows.map(row => ({
      installationId: row.id,
      specifier: row.specifier,
      driver: row.driver,
      estCapacity: row.estCapacity,
      kvCacheCapacity: row.kvCacheCapacity,
      port: row.port,
      settings: row.settings,
    })),
  };
}
