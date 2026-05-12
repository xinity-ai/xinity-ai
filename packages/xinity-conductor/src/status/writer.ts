import type { InstallationStatePayload, NodeRegistration } from "common-env";
import { eq, modelInstallationStateT, sql, aiNodeT } from "common-db";
import { getDB } from "../db";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "status.writer" });

/** Apply one runner's batched status updates to PG. Failures log and skip; no exceptions propagate. */
export async function flushBatch(nodeId: string, registration: NodeRegistration | undefined, installations: InstallationStatePayload[]): Promise<void> {
  if (registration) {
    try {
      await getDB()
        .update(aiNodeT)
        .set({
          host: registration.host,
          port: registration.port,
          estCapacity: registration.estCapacity,
          drivers: registration.drivers,
          driverVersions: registration.driverVersions,
          gpuCount: registration.gpuCount,
          gpus: registration.gpus,
          tls: registration.tls,
          available: true,
        })
        .where(eq(aiNodeT.id, nodeId));
    } catch (err) {
      log.warn({ err, nodeId }, "Failed to write registration");
    }
  }

  if (installations.length === 0) {
    return;
  }

  for (const inst of installations) {
    try {
      await getDB()
        .insert(modelInstallationStateT)
        .values({
          id: inst.installationId,
          lifecycleState: inst.lifecycleState,
          progress: inst.progress ?? null,
          statusMessage: inst.statusMessage ?? null,
          errorMessage: inst.errorMessage ?? null,
          failureLogs: inst.failureLogs ?? null,
        })
        .onConflictDoUpdate({
          target: modelInstallationStateT.id,
          set: {
            lifecycleState: inst.lifecycleState,
            progress: inst.progress ?? null,
            statusMessage: inst.statusMessage ?? null,
            errorMessage: inst.errorMessage ?? null,
            failureLogs: inst.failureLogs ?? null,
            updatedAt: sql`now()`,
          },
        });
    } catch (err) {
      log.warn({ err, installationId: inst.installationId }, "Failed to write installation state");
    }
  }
}
