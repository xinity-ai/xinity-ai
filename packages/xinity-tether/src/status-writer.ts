import { aiNodeT, inArray, modelInstallationStateT, modelInstallationT, sql } from "common-db";
import { keyFingerprint } from "common-env";
import type { NodeRegistration, InstallationStatePayload } from "common-env";
import { getDB } from "./db";
import { rootLogger } from "./logger";

const log = rootLogger.child({ name: "status-writer" });

export type RegistrationOutcome = "written" | "identity_mismatch";

/**
 * The pin is enforced by the upsert itself rather than a read followed by a write, so two daemons
 * racing to claim one id cannot both pass the check.
 */
export async function writeRegistration(reg: NodeRegistration): Promise<RegistrationOutcome> {
  const { nodeId, host, port, protocolFingerprint: _fingerprint, signature: _signature, ...rest } = reg;

  const outcome = await getDB().transaction(async (tx): Promise<RegistrationOutcome> => {
    const written = await tx
      .insert(aiNodeT)
      .values({ id: nodeId, host, port, ...rest })
      .onConflictDoUpdate({
        target: aiNodeT.id,
        set: { host, port, ...rest, deletedAt: null },
        setWhere: sql`${aiNodeT.publicKey} IS NULL OR ${aiNodeT.publicKey} = ${rest.publicKey}`,
      })
      .returning({ id: aiNodeT.id });

    if (written.length === 0) {
      return "identity_mismatch";
    }

    await tx
      .update(aiNodeT)
      .set({ available: false, deletedAt: new Date() })
      .where(sql`${aiNodeT.host} = ${host} AND ${aiNodeT.port} = ${port} AND ${aiNodeT.deletedAt} IS NULL AND ${aiNodeT.id} <> ${nodeId}`);

    return "written";
  });

  if (outcome === "identity_mismatch") {
    const [pinned] = await getDB()
      .select({ publicKey: aiNodeT.publicKey })
      .from(aiNodeT)
      .where(sql`${aiNodeT.id} = ${nodeId}`);
    log.error(
      {
        nodeId,
        host,
        pinned: pinned?.publicKey ? keyFingerprint(pinned.publicKey) : null,
        presented: keyFingerprint(rest.publicKey),
      },
      "Registration refused, this node id is pinned to a different key",
    );
    return outcome;
  }

  log.debug({ nodeId, host, port }, "Node registration written");
  return outcome;
}

export async function readPinnedPublicKey(nodeId: string): Promise<string | null> {
  const [row] = await getDB()
    .select({ publicKey: aiNodeT.publicKey })
    .from(aiNodeT)
    .where(sql`${aiNodeT.id} = ${nodeId}`);
  return row?.publicKey ?? null;
}

/** An installation the tether no longer knows is dropped, because a deployment deleted mid-report is a normal race. */
export async function partitionOwnedStates(
  nodeId: string,
  states: InstallationStatePayload[],
): Promise<{ owned: InstallationStatePayload[]; foreign: InstallationStatePayload[] }> {
  if (states.length === 0) {
    return { owned: [], foreign: [] };
  }

  const rows = await getDB()
    .select({ id: modelInstallationT.id, nodeId: modelInstallationT.nodeId })
    .from(modelInstallationT)
    .where(inArray(modelInstallationT.id, states.map((s) => s.installationId)));

  const owner = new Map(rows.map((r) => [r.id, r.nodeId]));
  const owned: InstallationStatePayload[] = [];
  const foreign: InstallationStatePayload[] = [];

  for (const state of states) {
    const actual = owner.get(state.installationId);
    if (actual === undefined) {
      continue;
    }
    (actual === nodeId ? owned : foreign).push(state);
  }

  return { owned, foreign };
}

const FLUSH_INTERVAL_MS = 200;
const pendingStates = new Map<string, InstallationStatePayload>();
let flushTimer: Timer | null = null;

export function queueInstallationStates(states: InstallationStatePayload[]): void {
  for (const state of states) {
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
