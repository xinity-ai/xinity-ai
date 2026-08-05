import { aiNodeT, modelInstallationStateT, sql } from "common-db";
import type { NodeRegistration, InstallationStateReport, InstallationStatePayload } from "common-env";
import { getDB } from "./db";
import { rootLogger } from "./logger";

const log = rootLogger.child({ name: "status-writer" });

export async function writeRegistration(reg: NodeRegistration): Promise<void> {
  const { nodeId, host, port, protocolFingerprint: _, ...rest } = reg;

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

  log.debug({ nodeId, host, port }, "Node registration written");
}

const FLUSH_INTERVAL_MS = 200;
const pendingStates = new Map<string, InstallationStatePayload>();
let flushTimer: Timer | null = null;

export function queueInstallationStates(report: InstallationStateReport): void {
  for (const state of report.states) {
    pendingStates.set(state.installationId, state);
  }
  if (flushTimer === null && pendingStates.size > 0) {
    flushTimer = setTimeout(() => void flushPending(), FLUSH_INTERVAL_MS);
  }
}

async function flushPending(): Promise<void> {
  flushTimer = null;
  if (pendingStates.size === 0) {
    return;
  }

  const batch = [...pendingStates.values()];
  pendingStates.clear();

  try {
    const values = batch.map((s) => ({
      id: s.installationId,
      lifecycleState: s.lifecycleState,
      progress: s.progress ?? null,
      statusMessage: s.statusMessage ?? null,
      errorMessage: s.errorMessage ?? null,
      failureLogs: s.failureLogs ?? null,
    }));

    await getDB()
      .insert(modelInstallationStateT)
      .values(values)
      .onConflictDoUpdate({
        target: modelInstallationStateT.id,
        set: {
          lifecycleState: sql`excluded.lifecycle_state`,
          progress: sql`excluded.progress`,
          statusMessage: sql`excluded.status_message`,
          errorMessage: sql`excluded.error_message`,
          failureLogs: sql`excluded.failure_logs`,
        },
      });

    log.debug({ count: batch.length }, "Batch state flush completed");
  } catch (err) {
    log.error({ err, count: batch.length }, "Batch state flush failed");
  }
}

export async function flushAndStop(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushPending();
}
