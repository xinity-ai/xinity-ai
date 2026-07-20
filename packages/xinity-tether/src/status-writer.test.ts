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

mock.module("./metrics", () => ({
  incRegistrationWrites: () => {},
  incStateWrites: () => {},
  incSSEConnections: () => {},
  incDesiredStatePushes: () => {},
  incLivenessTimeouts: () => {},
  setConnectedNodes: () => {},
  handleMetrics: () => new Response(""),
}));

const { writeRegistration, writeInstallationStates } = await import("./status-writer");

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
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("writeInstallationStates", () => {
  beforeEach(() => {
    mockInsert.mockClear();
    mockInsertValues.mockClear();
    mockOnConflictDoUpdate.mockClear();
  });

  test("writes each state as an upsert", async () => {
    await writeInstallationStates({
      nodeId: "node-1",
      states: [
        { installationId: "inst-1", lifecycleState: "ready" },
        { installationId: "inst-2", lifecycleState: "downloading", progress: 0.5 },
      ],
    });

    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(2);
  });

  test("handles empty states array", async () => {
    await writeInstallationStates({
      nodeId: "node-1",
      states: [],
    });

    expect(mockInsert).not.toHaveBeenCalled();
  });

  test("writes failure details when provided", async () => {
    await writeInstallationStates({
      nodeId: "node-1",
      states: [{
        installationId: "inst-3",
        lifecycleState: "failed",
        errorMessage: "GPU out of memory",
        failureLogs: "torch.cuda.OutOfMemoryError",
      }],
    });

    expect(mockInsert).toHaveBeenCalledTimes(1);
  });
});
