import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockOnConflictDoUpdate = mock(() => Promise.resolve());
const mockInsertValues = mock(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockInsert = mock(() => ({ values: mockInsertValues }));

const mockUpdateSet = mock(() => ({ where: mock(() => Promise.resolve()) }));
const mockUpdate = mock(() => ({ set: mockUpdateSet }));

const mockTxInsert = mock(() => ({ values: mockInsertValues }));
const mockTxUpdate = mock(() => ({ set: mockUpdateSet }));
const mockTransaction = mock(async (fn: (tx: unknown) => Promise<void>) => {
  await fn({ insert: mockTxInsert, update: mockTxUpdate });
});

mock.module("./env", () => ({
  env: { TETHER_SECRET: "test", METRICS_AUTH: undefined },
}));

mock.module("./db", () => ({
  getDB: () => ({
    insert: mockInsert,
    update: mockUpdate,
    transaction: mockTransaction,
  }),
}));

mock.module("./logger", () => ({
  rootLogger: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}));

const { writeRegistration, queueInstallationStates, flushAndStop } = await import("./status-writer");

describe("writeRegistration", () => {
  beforeEach(() => {
    mockTransaction.mockClear();
    mockTxInsert.mockClear();
    mockTxUpdate.mockClear();
    mockInsertValues.mockClear();
    mockOnConflictDoUpdate.mockClear();
    mockUpdateSet.mockClear();
  });

  test("calls transaction for registration upsert", async () => {
    await writeRegistration({
      nodeId: "node-1",
      host: "10.0.0.1",
      port: 4020,
      gpuCount: 1,
      gpus: [{ vendor: "nvidia", name: "RTX 4090", vramMb: 24576 }],
      driverVersions: { vllm: "0.8.0" },
      driverFeatures: {},
      tls: false,
      estCapacity: 24,
      authToken: "token-abc",
      protocolFingerprint: "test",
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  test("passes machineName when provided", async () => {
    await writeRegistration({
      nodeId: "node-2",
      host: "10.0.0.2",
      port: 4020,
      gpuCount: 2,
      gpus: [],
      driverVersions: {},
      driverFeatures: {},
      tls: true,
      estCapacity: 48,
      machineName: "gpu-server-1",
      authToken: "token-def",
      protocolFingerprint: "test",
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("queueInstallationStates", () => {
  beforeEach(async () => {
    await flushAndStop();
    mockInsert.mockClear();
    mockInsertValues.mockClear();
    mockOnConflictDoUpdate.mockClear();
  });

  test("batches writes with a 200ms flush", async () => {
    queueInstallationStates({
      nodeId: "node-1",
      states: [
        { installationId: "inst-1", lifecycleState: "ready" },
        { installationId: "inst-2", lifecycleState: "downloading", progress: 0.5 },
      ],
    });

    expect(mockInsert).not.toHaveBeenCalled();

    await Bun.sleep(250);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    const values = (mockInsertValues.mock.calls as unknown as unknown[][])[0]![0] as unknown[];
    expect(values).toHaveLength(2);
  });

  test("deduplicates by installationId, keeping latest", async () => {
    queueInstallationStates({
      nodeId: "node-1",
      states: [{ installationId: "inst-1", lifecycleState: "downloading", progress: 0.2 }],
    });
    queueInstallationStates({
      nodeId: "node-1",
      states: [{ installationId: "inst-1", lifecycleState: "downloading", progress: 0.8 }],
    });

    await Bun.sleep(250);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const values = (mockInsertValues.mock.calls as unknown as unknown[][])[0]![0] as Array<{ id: string; progress: number | null }>;
    expect(values).toHaveLength(1);
    expect(values[0]!.progress).toBe(0.8);
  });

  test("handles empty states array", async () => {
    queueInstallationStates({
      nodeId: "node-1",
      states: [],
    });

    await Bun.sleep(250);

    expect(mockInsert).not.toHaveBeenCalled();
  });

  test("flushAndStop writes pending states immediately", async () => {
    queueInstallationStates({
      nodeId: "node-1",
      states: [{ installationId: "inst-3", lifecycleState: "failed", errorMessage: "OOM" }],
    });

    await flushAndStop();

    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  test("merges reports from different daemons into one batch", async () => {
    queueInstallationStates({
      nodeId: "node-1",
      states: [{ installationId: "inst-a", lifecycleState: "ready" }],
    });
    queueInstallationStates({
      nodeId: "node-2",
      states: [{ installationId: "inst-b", lifecycleState: "installing" }],
    });

    await Bun.sleep(250);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const values = (mockInsertValues.mock.calls as unknown as unknown[][])[0]![0] as unknown[];
    expect(values).toHaveLength(2);
  });
});
