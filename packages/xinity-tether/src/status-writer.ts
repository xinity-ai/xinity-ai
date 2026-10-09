import { aiNodeT, driverErrorCode, inArray, modelInstallationStateT, modelInstallationT, sql, TransactionRollbackError } from "common-db";
import { keyFingerprint } from "common-env";
import type { NodeRegistration, InstallationStatePayload } from "common-env";
import { getDB } from "./db";
import { rootLogger } from "./logger";

const log = rootLogger.child({ name: "status-writer" });

export type RegistrationOutcome = "written" | "identity_mismatch";

/**
 * The pin is enforced by the upsert itself rather than a read followed by a write, so two daemons
 * racing to claim one id cannot both pass the check. The old node on the host is retired first
 * because the live host:port index would reject the insert, and a refused claim rolls that back.
 */
export async function writeRegistration(reg: NodeRegistration): Promise<RegistrationOutcome> {
  const { nodeId, host, port, protocolFingerprint: _fingerprint, signature: _signature, ...rest } = reg;

  const outcome = await getDB().transaction(async (tx): Promise<RegistrationOutcome> => {
    await tx
      .update(aiNodeT)
      .set({ available: false, deletedAt: new Date() })
      .where(sql`${aiNodeT.host} = ${host} AND ${aiNodeT.port} = ${port} AND ${aiNodeT.deletedAt} IS NULL AND ${aiNodeT.id} <> ${nodeId}`);

    const written = await tx
      .insert(aiNodeT)
      .values({ id: nodeId, host, port, ...rest, available: true })
      .onConflictDoUpdate({
        target: aiNodeT.id,
        set: { host, port, ...rest, available: true, deletedAt: null },
        setWhere: sql`${aiNodeT.publicKey} IS NULL OR ${aiNodeT.publicKey} = ${rest.publicKey}`,
      })
      .returning({ id: aiNodeT.id });

    if (written.length === 0) {
      tx.rollback();
    }

    return "written";
  }).catch((err: unknown): RegistrationOutcome => {
    if (err instanceof TransactionRollbackError) {
      return "identity_mismatch";
    }
    throw err;
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
const MAX_RETRY_DELAY_MS = 30_000;
const FOREIGN_KEY_VIOLATION = "23503";
const pendingStates = new Map<string, InstallationStatePayload>();
let flushTimer: Timer | null = null;
let flushing: Promise<void> | null = null;
let failedFlushes = 0;

export function queueInstallationStates(states: InstallationStatePayload[]): void {
  for (const state of states) {
    pendingStates.set(state.installationId, state);
  }
  scheduleFlush();
}

// One flush at a time, so an older batch can never land after a newer one. A running flush schedules the next itself.
function scheduleFlush(): void {
  if (flushTimer !== null || flushing !== null || pendingStates.size === 0) {
    return;
  }
  const delayMs = Math.min(FLUSH_INTERVAL_MS * 2 ** failedFlushes, MAX_RETRY_DELAY_MS);
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    flushing = flushPending();
    await flushing;
    flushing = null;
    scheduleFlush();
  }, delayMs);
}

async function flushPending(): Promise<void> {
  const batch = [...pendingStates.values()];
  pendingStates.clear();
  if (batch.length === 0) {
    return;
  }

  try {
    await writeStates(batch);
    failedFlushes = 0;
  } catch (err) {
    failedFlushes++;
    log.error({ err, count: batch.length }, "Batch state flush failed");
    for (const state of await withoutVanishedInstallations(batch, err)) {
      if (!pendingStates.has(state.installationId)) {
        pendingStates.set(state.installationId, state);
      }
    }
  }
}

async function writeStates(batch: InstallationStatePayload[]): Promise<void> {
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
}

// A state for an installation hard-deleted after it was queued fails the whole insert on every retry.
async function withoutVanishedInstallations(
  batch: InstallationStatePayload[],
  err: unknown,
): Promise<InstallationStatePayload[]> {
  if (driverErrorCode(err) !== FOREIGN_KEY_VIOLATION) {
    return batch;
  }
  const existing = await getDB()
    .select({ id: modelInstallationT.id })
    .from(modelInstallationT)
    .where(inArray(modelInstallationT.id, batch.map((s) => s.installationId)))
    .catch(() => null);
  if (existing === null) {
    return batch;
  }
  const existingIds = new Set(existing.map((row) => row.id));
  const vanished = batch.filter((s) => !existingIds.has(s.installationId)).map((s) => s.installationId);
  if (vanished.length > 0) {
    log.warn({ installationIds: vanished }, "Dropping states of installations that no longer exist");
  }
  return batch.filter((s) => existingIds.has(s.installationId));
}

// The running flush schedules a retry as it settles, so the timer is cleared only after waiting for it.
export async function flushAndStop(): Promise<void> {
  await flushing;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushPending();
}

