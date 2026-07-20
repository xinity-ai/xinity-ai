import { aiNodeT, modelInstallationStateT, sql } from "common-db";
import type { NodeRegistration, InstallationStateReport } from "common-env";
import { getDB } from "./db";
import { rootLogger } from "./logger";
import { incRegistrationWrites, incStateWrites } from "./metrics";

const log = rootLogger.child({ name: "status-writer" });

export async function writeRegistration(reg: NodeRegistration): Promise<void> {
  const { nodeId, host, port, ...rest } = reg;

  await getDB().transaction(async (tx) => {
    await tx
      .update(aiNodeT)
      .set({ available: false, deletedAt: new Date() })
      .where(sql`${aiNodeT.host} = ${host} AND ${aiNodeT.port} = ${port} AND ${aiNodeT.deletedAt} IS NULL AND ${aiNodeT.id} <> ${nodeId}`);

    await tx
      .insert(aiNodeT)
      .values({ id: nodeId, host, port, ...rest })
      .onConflictDoUpdate({
        target: aiNodeT.id,
        set: { host, port, ...rest, deletedAt: null },
      });
  });

  incRegistrationWrites();
  log.debug({ nodeId, host, port }, "Node registration written");
}

export async function writeInstallationStates(report: InstallationStateReport): Promise<void> {
  const db = getDB();

  for (const state of report.states) {
    const fields = {
      lifecycleState: state.lifecycleState,
      progress: state.progress ?? null,
      statusMessage: state.statusMessage ?? null,
      errorMessage: state.errorMessage ?? null,
      failureLogs: state.failureLogs ?? null,
    };

    await db
      .insert(modelInstallationStateT)
      .values({ id: state.installationId, ...fields })
      .onConflictDoUpdate({ set: fields, target: modelInstallationStateT.id });

    incStateWrites();
  }

  log.debug({ nodeId: report.nodeId, count: report.states.length }, "Installation states written");
}
