import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { aiNodeT, modelInstallationT, preconfigureDB, sql } from "common-db";
import {
  createTempStateDir,
  getAvailablePort,
  startDaemon,
  startMockOllamaServer,
  stopDaemon,
  waitForInstallationState,
  waitForNodeAvailability,
  waitForNodeIdFile,
  writeNodeId,
} from "./daemon-test-helpers";

const DB_CONNECTION_URL = process.env.DB_CONNECTION_URL!;
const { getDB } = preconfigureDB(DB_CONNECTION_URL);
const db = getDB();

const runningDaemons: Bun.Subprocess[] = [];
const runningMocks: Array<() => void> = [];
const createdNodeIds: string[] = [];
const createdInstallationIds: string[] = [];

afterAll(async () => {
  for (const proc of runningDaemons) {
    await stopDaemon(proc);
  }
  for (const stop of runningMocks) {
    stop();
  }

  // Soft-delete test data to reduce log noise when running the app locally
  const now = new Date();
  for (const id of createdInstallationIds) {
    try { await db.update(modelInstallationT).set({ deletedAt: now }).where(sql`${modelInstallationT.id} = ${id}`); } catch {}
  }
  for (const id of createdNodeIds) {
    try { await db.update(aiNodeT).set({ deletedAt: now }).where(sql`${aiNodeT.id} = ${id}`); } catch {}
  }
});

async function waitForCondition(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await Bun.sleep(200);
  }
  throw new Error("Timed out waiting for condition");
}

describe("xinity-ai-daemon", () => {
  it("registers a new node and writes node_id", async () => {
    const stateDir = createTempStateDir();
    const mock = await startMockOllamaServer();
    runningMocks.push(mock.stop);

    const proc = await startDaemon({
      stateDir,
      ollamaEndpoint: mock.endpoint,
      syncIntervalMs: 500,
    });
    runningDaemons.push(proc);

    const nodeId = await waitForNodeIdFile(stateDir, 10_000);
    createdNodeIds.push(nodeId);
    const [node] = await db.select().from(aiNodeT).where(sql`${aiNodeT.id} = ${nodeId}`).limit(1);
    expect(node).toBeTruthy();
  });

  it("resumes with an existing node_id entry", async () => {
    const stateDir = createTempStateDir();
    const mock = await startMockOllamaServer();
    runningMocks.push(mock.stop);

    const nodeId = randomUUID();
    const nodePort = await getAvailablePort();
    await db.insert(aiNodeT).values({
      id: nodeId,
      host: "127.0.0.1",
      port: nodePort,
      estCapacity: 10,
      available: false,
    });
    createdNodeIds.push(nodeId);
    await writeNodeId(stateDir, nodeId);

    const proc = await startDaemon({
      stateDir,
      ollamaEndpoint: mock.endpoint,
      syncIntervalMs: 500,
    });
    runningDaemons.push(proc);

    const readId = await waitForNodeIdFile(stateDir, 5_000);
    expect(readId).toBe(nodeId);

    await waitForNodeAvailability(nodeId, true, 10_000);
  });

  it("syncs model installations via Ollama and records progress", async () => {
    const stateDir = createTempStateDir();
    const mock = await startMockOllamaServer();
    runningMocks.push(mock.stop);

    const nodeId = randomUUID();
    const nodePort = await getAvailablePort();
    await db.insert(aiNodeT).values({
      id: nodeId,
      host: "127.0.0.1",
      port: nodePort,
      estCapacity: 10,
      available: true,
    });
    createdNodeIds.push(nodeId);
    await writeNodeId(stateDir, nodeId);

    const [installation] = await db.insert(modelInstallationT).values({
      nodeId,
      model: `test-model-${nodeId}`,
      estCapacity: 1,
      port: nodePort,
      driver: "ollama",
    }).returning();
    createdInstallationIds.push(installation.id);

    const proc = await startDaemon({
      stateDir,
      ollamaEndpoint: mock.endpoint,
      syncIntervalMs: 500,
    });
    runningDaemons.push(proc);

    await waitForInstallationState(installation.id, 15_000);
    expect(mock.calls.pull.length).toBeGreaterThan(0);
  });

  it("marks node available on start and unavailable on shutdown", async () => {
    const stateDir = createTempStateDir();
    const mock = await startMockOllamaServer();
    runningMocks.push(mock.stop);

    const proc = await startDaemon({
      stateDir,
      ollamaEndpoint: mock.endpoint,
      syncIntervalMs: 500,
    });
    runningDaemons.push(proc);

    const nodeId = await waitForNodeIdFile(stateDir, 10_000);
    createdNodeIds.push(nodeId);
    await waitForNodeAvailability(nodeId, true, 10_000);

    await stopDaemon(proc);

    await waitForNodeAvailability(nodeId, false, 10_000);
  });

  it("issues delete calls when models should be removed", async () => {
    const stateDir = createTempStateDir();
    const mock = await startMockOllamaServer();
    runningMocks.push(mock.stop);

    const nodeId = randomUUID();
    const nodePort = await getAvailablePort();
    await db.insert(aiNodeT).values({
      id: nodeId,
      host: "127.0.0.1",
      port: nodePort,
      estCapacity: 10,
      available: true,
    });
    createdNodeIds.push(nodeId);
    await writeNodeId(stateDir, nodeId);

    const staleModel = `stale-${nodeId}`;
    mock.addInstalledModel(staleModel);

    const proc = await startDaemon({
      stateDir,
      ollamaEndpoint: mock.endpoint,
      syncIntervalMs: 500,
    });
    runningDaemons.push(proc);

    await waitForCondition(
      () => mock.calls.delete.some(call => call.model === staleModel),
      10_000
    );
  });

  it("handles combined install and delete actions in one sync", async () => {
    const stateDir = createTempStateDir();
    const mock = await startMockOllamaServer();
    runningMocks.push(mock.stop);

    const nodeId = randomUUID();
    const nodePort = await getAvailablePort();
    await db.insert(aiNodeT).values({
      id: nodeId,
      host: "127.0.0.1",
      port: nodePort,
      estCapacity: 10,
      available: true,
    });
    createdNodeIds.push(nodeId);
    await writeNodeId(stateDir, nodeId);

    const removeModel = `remove-${nodeId}`;
    const addModel = `add-${nodeId}`;
    mock.addInstalledModel(removeModel);

    const [installation] = await db.insert(modelInstallationT).values({
      nodeId,
      model: addModel,
      estCapacity: 1,
      port: nodePort,
      driver: "ollama",
    }).returning();
    createdInstallationIds.push(installation.id);

    const proc = await startDaemon({
      stateDir,
      ollamaEndpoint: mock.endpoint,
      syncIntervalMs: 500,
    });
    runningDaemons.push(proc);

    await waitForCondition(
      () => mock.calls.delete.some(call => call.model === removeModel),
      10_000
    );
    await waitForInstallationState(installation.id, 15_000);
    expect(mock.calls.pull.some(call => call.model === addModel)).toBe(true);
  });
});
