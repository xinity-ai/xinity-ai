import { describe, test, expect, mock, beforeEach, jest } from "bun:test";
import { TransactionRollbackError } from "common-db";

const mockReturning = mock(() => Promise.resolve([{ id: "node-1" }] as { id: string }[]));
const mockOnConflictDoUpdate = mock(() => Object.assign(Promise.resolve(), { returning: mockReturning }));
const mockInsertValues = mock(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockInsert = mock(() => ({ values: mockInsertValues }));

const mockUpdateSet = mock(() => ({ where: mock(() => Promise.resolve()) }));
const mockUpdate = mock(() => ({ set: mockUpdateSet }));

const mockSelectRows = mock(() => Promise.resolve([] as Record<string, unknown>[]));
const mockSelect = mock(() => ({ from: () => ({ where: () => mockSelectRows() }) }));

let txStatements: string[] = [];
let txCommitted: boolean | undefined;
const mockTxInsert = mock(() => {
  txStatements.push("insert");
  return { values: mockInsertValues };
});
const mockTxUpdate = mock(() => {
  txStatements.push("update");
  return { set: mockUpdateSet };
});
const mockTransaction = mock(async (fn: (tx: unknown) => Promise<unknown>) => {
  const rollback = () => {
    throw new TransactionRollbackError();
  };
  try {
    const result = await fn({ insert: mockTxInsert, update: mockTxUpdate, rollback });
    txCommitted = true;
    return result;
  } catch (err) {
    txCommitted = false;
    throw err;
  }
});

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

async function waitForInserts(count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (mockInsert.mock.calls.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`expected ${count} inserts, saw ${mockInsert.mock.calls.length}`);
    }
    await Bun.sleep(10);
  }
}

function insertedValues(call: number): Array<{ id: string; lifecycleState: string }> {
  return (mockInsertValues.mock.calls as unknown as unknown[][])[call]![0] as Array<{ id: string; lifecycleState: string }>;
}

function holdNextInsert(): (err: Error) => void {
  let reject!: (err: Error) => void;
  mockOnConflictDoUpdate.mockImplementationOnce(() =>
    Object.assign(new Promise<void>((_, rej) => { reject = rej; }), { returning: mockReturning }));
  return (err) => reject(err);
}

describe("writeRegistration", () => {
  beforeEach(() => {
    mockTransaction.mockClear();
    mockTxInsert.mockClear();
    mockTxUpdate.mockClear();
    mockInsertValues.mockClear();
    mockOnConflictDoUpdate.mockClear();
    mockUpdateSet.mockClear();
    mockReturning.mockImplementation(() => Promise.resolve([{ id: "node-1" }]));
    txStatements = [];
    txCommitted = undefined;
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

    expect(txStatements).toEqual(["update", "insert"]);
    expect(txCommitted).toBe(false);
  });

  test("retires the node already on the host before registering a new id there", async () => {
    expect(await writeRegistration(registration)).toBe("written");

    expect(txStatements).toEqual(["update", "insert"]);
    const retired = (mockUpdateSet.mock.calls as unknown as unknown[][])[0]![0] as Record<string, unknown>;
    expect(retired.available).toBe(false);
    expect(retired.deletedAt).toBeInstanceOf(Date);
    expect(txCommitted).toBe(true);
  });

  test("passes through database errors other than a refused claim", async () => {
    mockReturning.mockImplementation(() => Promise.reject(new Error("connection lost")));

    await expect(writeRegistration(registration)).rejects.toThrow("connection lost");
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
    mockInsert.mockReset();
    mockInsert.mockImplementation(() => ({ values: mockInsertValues }));
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

  test("retries a batch when the database flush fails", async () => {
    mockInsert.mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });

    queueInstallationStates([{ installationId: "inst-retry", lifecycleState: "ready" }]);

    await waitForInserts(2);
    expect(insertedValues(0).map((v) => v.id)).toEqual(["inst-retry"]);
  });

  test("a state queued while a failing flush is in flight wins over the failed batch", async () => {
    const rejectFirst = holdNextInsert();

    queueInstallationStates([{ installationId: "inst-race", lifecycleState: "downloading", progress: 0.5 }]);
    await waitForInserts(1);
    queueInstallationStates([{ installationId: "inst-race", lifecycleState: "ready" }]);
    rejectFirst(new Error("database unavailable"));

    await waitForInserts(2);
    expect(insertedValues(1)).toEqual([expect.objectContaining({ id: "inst-race", lifecycleState: "ready" })]);
  });

  test("drops states of installations that vanished when the insert hits a foreign key violation", async () => {
    const foreignKeyViolation = Object.assign(new Error("violates foreign key constraint"), { code: "23503" });
    mockInsert.mockImplementationOnce(() => {
      throw new Error("Failed query", { cause: foreignKeyViolation });
    });
    mockSelectRows.mockImplementation(() => Promise.resolve([{ id: "inst-kept" }]));

    queueInstallationStates([
      { installationId: "inst-kept", lifecycleState: "ready" },
      { installationId: "inst-gone", lifecycleState: "ready" },
    ]);

    await waitForInserts(2);
    expect(insertedValues(0).map((v) => v.id)).toEqual(["inst-kept"]);
  });

  test("a flush failing during flushAndStop schedules no retry", async () => {
    const rejectFirst = holdNextInsert();
    queueInstallationStates([{ installationId: "inst-stop", lifecycleState: "ready" }]);
    await waitForInserts(1);

    mockInsert.mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    jest.useFakeTimers();
    try {
      const stopping = flushAndStop();
      rejectFirst(new Error("database unavailable"));
      await stopping;

      expect(mockInsert).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
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
