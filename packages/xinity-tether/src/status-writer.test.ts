import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockReturning = mock(() => Promise.resolve([{ id: "node-1" }] as { id: string }[]));
const mockOnConflictDoUpdate = mock(() => Object.assign(Promise.resolve(), { returning: mockReturning }));
const mockInsertValues = mock(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockInsert = mock(() => ({ values: mockInsertValues }));

const mockUpdateSet = mock(() => ({ where: mock(() => Promise.resolve()) }));
const mockUpdate = mock(() => ({ set: mockUpdateSet }));

const mockSelectRows = mock(() => Promise.resolve([] as Record<string, unknown>[]));
const mockSelect = mock(() => ({ from: () => ({ where: () => mockSelectRows() }) }));

const mockTxInsert = mock(() => ({ values: mockInsertValues }));
const mockTxUpdate = mock(() => ({ set: mockUpdateSet }));
const mockTransaction = mock(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({ insert: mockTxInsert, update: mockTxUpdate }),
);

mock.module("./config", () => ({
  config: { tetherSecret: "test", metrics: { auth: undefined } },
}));

mock.module("./db", () => ({
  getDB: () => ({
    insert: mockInsert,
    update: mockUpdate,
    select: mockSelect,
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

const { writeRegistration, queueInstallationStates, flushAndStop, readPinnedPublicKey, partitionOwnedStates } =
  await import("./status-writer");

const registration = {
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
  publicKey: "pub-key-1",
  signature: "sig",
};

describe("writeRegistration", () => {
  beforeEach(() => {
    mockTransaction.mockClear();
    mockTxInsert.mockClear();
    mockTxUpdate.mockClear();
    mockInsertValues.mockClear();
    mockOnConflictDoUpdate.mockClear();
    mockUpdateSet.mockClear();
    mockReturning.mockImplementation(() => Promise.resolve([{ id: "node-1" }]));
  });

  test("writes the node and never stores the request signature", async () => {
    expect(await writeRegistration(registration)).toBe("written");

    const values = (mockInsertValues.mock.calls as unknown as unknown[][])[0]![0] as Record<string, unknown>;
    expect(values.publicKey).toBe("pub-key-1");
    expect(values).not.toHaveProperty("signature");
    expect(values).not.toHaveProperty("protocolFingerprint");
  });

  test("refuses when the upsert matched no row, meaning the id is pinned elsewhere", async () => {
    mockReturning.mockImplementation(() => Promise.resolve([]));
    mockSelectRows.mockImplementation(() => Promise.resolve([{ publicKey: "another-key" }]));

    expect(await writeRegistration(registration)).toBe("identity_mismatch");
  });

  test("leaves other nodes on the same host alone when the claim is refused", async () => {
    mockReturning.mockImplementation(() => Promise.resolve([]));
    mockSelectRows.mockImplementation(() => Promise.resolve([{ publicKey: "another-key" }]));

    await writeRegistration(registration);

    expect(mockTxUpdate).not.toHaveBeenCalled();
  });
});

describe("readPinnedPublicKey", () => {
  test("reads null for a node that has never registered", async () => {
    mockSelectRows.mockImplementation(() => Promise.resolve([]));
    expect(await readPinnedPublicKey("node-1")).toBeNull();
  });
});

describe("partitionOwnedStates", () => {
  const state = (id: string) => ({ installationId: id, lifecycleState: "ready" as const });

  test("drops installations the tether no longer knows", async () => {
    mockSelectRows.mockImplementation(() => Promise.resolve([{ id: "inst-1", nodeId: "node-1" }]));

    const { owned, foreign } = await partitionOwnedStates("node-1", [state("inst-1"), state("gone")]);

    expect(owned.map((s) => s.installationId)).toEqual(["inst-1"]);
    expect(foreign).toHaveLength(0);
  });

  test("separates an installation owned by another node", async () => {
    mockSelectRows.mockImplementation(() => Promise.resolve([
      { id: "inst-1", nodeId: "node-1" },
      { id: "inst-2", nodeId: "node-2" },
    ]));

    const { owned, foreign } = await partitionOwnedStates("node-1", [state("inst-1"), state("inst-2")]);

    expect(owned.map((s) => s.installationId)).toEqual(["inst-1"]);
    expect(foreign.map((s) => s.installationId)).toEqual(["inst-2"]);
  });

  test("asks the database nothing for an empty report", async () => {
    mockSelect.mockClear();

    expect(await partitionOwnedStates("node-1", [])).toEqual({ owned: [], foreign: [] });
    expect(mockSelect).not.toHaveBeenCalled();
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
    queueInstallationStates([
      { installationId: "inst-1", lifecycleState: "ready" },
      { installationId: "inst-2", lifecycleState: "downloading", progress: 0.5 },
    ]);

    expect(mockInsert).not.toHaveBeenCalled();

    await Bun.sleep(250);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    const values = (mockInsertValues.mock.calls as unknown as unknown[][])[0]![0] as unknown[];
    expect(values).toHaveLength(2);
  });

  test("deduplicates by installationId, keeping latest", async () => {
    queueInstallationStates([{ installationId: "inst-1", lifecycleState: "downloading", progress: 0.2 }]);
    queueInstallationStates([{ installationId: "inst-1", lifecycleState: "downloading", progress: 0.8 }]);

    await Bun.sleep(250);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const values = (mockInsertValues.mock.calls as unknown as unknown[][])[0]![0] as Array<{ id: string; progress: number | null }>;
    expect(values).toHaveLength(1);
    expect(values[0]!.progress).toBe(0.8);
  });

  test("handles empty states array", async () => {
    queueInstallationStates([]);

    await Bun.sleep(250);

    expect(mockInsert).not.toHaveBeenCalled();
  });

  test("flushAndStop writes pending states immediately", async () => {
    queueInstallationStates([{ installationId: "inst-3", lifecycleState: "failed", errorMessage: "OOM" }]);

    await flushAndStop();

    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  test("merges reports from different daemons into one batch", async () => {
    queueInstallationStates([{ installationId: "inst-a", lifecycleState: "ready" }]);
    queueInstallationStates([{ installationId: "inst-b", lifecycleState: "installing" }]);

    await Bun.sleep(250);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const values = (mockInsertValues.mock.calls as unknown as unknown[][])[0]![0] as unknown[];
    expect(values).toHaveLength(2);
  });
});
