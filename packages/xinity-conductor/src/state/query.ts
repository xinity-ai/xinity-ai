import { and, eq, isNull, modelInstallationT } from "common-db";
import type { DesiredState } from "common-env";
import { getDB } from "../db";

/** Build the full desired-state payload for a given node, mirroring what the runner would have read directly from PG. */
export async function buildDesiredState(nodeId: string): Promise<DesiredState> {
  const rows = await getDB()
    .select({
      installationId: modelInstallationT.id,
      specifier: modelInstallationT.specifier,
      model: modelInstallationT.model,
      driver: modelInstallationT.driver,
      estCapacity: modelInstallationT.estCapacity,
      kvCacheCapacity: modelInstallationT.kvCacheCapacity,
      port: modelInstallationT.port,
    })
    .from(modelInstallationT)
    .where(and(eq(modelInstallationT.nodeId, nodeId), isNull(modelInstallationT.deletedAt)));

  return {
    nodeId,
    installations: rows,
  };
}
