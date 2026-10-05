import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { aiNodeT, modelDeploymentT, modelInstallationT, organizationT, preconfigureDB, sql } from "common-db";
import {
  createTempStateDir,
  getAvailablePort,
  startDaemon,
  startMockOllamaServer,
  stopDaemon,
  stopTetherMock,
  waitForInstallationState,
  waitForNodeAvailability,
  waitForNodeIdFile,
  writeNodeIdentity,
  type DaemonHandle,
} from "./daemon-test-helpers";

const DB_CONNECTION_URL = process.env.DB_CONNECTION_URL!;
const { getDB } = preconfigureDB(DB_CONNECTION_URL);
const db = getDB();

const runningDaemons: DaemonHandle[] = [];
const runningMocks: Array<() => void> = [];
const createdNodeIds: string[] = [];
const createdInstallationIds: string[] = [];
const createdDeploymentIds: string[] = [];
const createdOrganizationIds: string[] = [];

afterAll(async () => {
  for (const handle of runningDaemons) {
    await stopDaemon(handle);
    stopTetherMock(handle);
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
  // Deleting a deployment also deletes its installations.
  for (const id of createdDeploymentIds) {
    try { await db.delete(modelDeploymentT).where(sql`${modelDeploymentT.id} = ${id}`); } catch {}
  }
  for (const id of createdOrganizationIds) {
    try { await db.delete(organizationT).where(sql`${organizationT.id} = ${id}`); } catch {}
  }
});

async function createDeployment(specifier: string): Promise<string> {
  const organizationId = `org-${randomUUID()}`;
  await db.insert(organizationT).values({ id: organizationId, name: "Daemon System Tests", slug: `daemon-tests-${randomUUID()}` });
  const [deployment] = await db.insert(modelDeploymentT).values({
    organizationId,
    name: "Daemon Test Model",
    publicSpecifier: `${specifier}-${randomUUID()}`,
    specifier,
  }).returning();
  createdDeploymentIds.push(deployment!.id);
  createdOrganizationIds.push(organizationId);
  return deployment!.id;
}

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
      ollamaUrl: mock.endpoint,
      syncIntervalMs: 500,
    });
    runningDaemons.push(proc);

    const nodeId = await waitForNodeIdFile(stateDir, 10_000);
    createdNodeIds.push(nodeId);
    await waitForNodeAvailability(nodeId, true, 10_000);
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
    await writeNodeIdentity(stateDir, nodeId);

    const proc = await startDaemon({
      stateDir,
      ollamaUrl: mock.endpoint,
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
    await writeNodeIdentity(stateDir, nodeId);

    const [installation] = await db.insert(modelInstallationT).values({
      nodeId,
      deploymentId: await createDeployment("ministral-3-m"),
      specifier: "ministral-3-m",
      estCapacity: 1,
      port: nodePort,
      driver: "ollama",
    }).returning();
    createdInstallationIds.push(installation!.id);

    const proc = await startDaemon({
      stateDir,
      ollamaUrl: mock.endpoint,
      syncIntervalMs: 500,
    });
    runningDaemons.push(proc);

    await waitForInstallationState(installation!.id, 15_000);
    expect(mock.calls.pull.length).toBeGreaterThan(0);
  });

  it("marks node available on start and unavailable on shutdown", async () => {
    const stateDir = createTempStateDir();
    const mock = await startMockOllamaServer();
    runningMocks.push(mock.stop);

    const proc = await startDaemon({
      stateDir,
      ollamaUrl: mock.endpoint,
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
    await writeNodeIdentity(stateDir, nodeId);

    const staleModel = `stale-${nodeId}`;
    mock.addInstalledModel(staleModel);

    const proc = await startDaemon({
      stateDir,
      ollamaUrl: mock.endpoint,
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
    await writeNodeIdentity(stateDir, nodeId);

    const removeModel = `remove-${nodeId}`;
    // Catalog entry from packages/xinity-infoserver/models.yaml; the daemon
    // resolves the specifier to this ollama tag before pulling.
    const addSpecifier = "qwen3-coder-next-large";
    const addModelTag = "qwen3-coder-next:q8_0";
    mock.addInstalledModel(removeModel);

    const [installation] = await db.insert(modelInstallationT).values({
      nodeId,
      deploymentId: await createDeployment(addSpecifier),
      specifier: addSpecifier,
      estCapacity: 1,
      port: nodePort,
      driver: "ollama",
    }).returning();
    createdInstallationIds.push(installation!.id);

    const proc = await startDaemon({
      stateDir,
      ollamaUrl: mock.endpoint,
      syncIntervalMs: 500,
    });
    runningDaemons.push(proc);

    await waitForCondition(
      () => mock.calls.delete.some(call => call.model === removeModel),
      10_000
    );
    await waitForInstallationState(installation!.id, 15_000);
    expect(mock.calls.pull.some(call => call.model === addModelTag)).toBe(true);
  });
});
