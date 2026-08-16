import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import { firstValueFrom } from "rxjs";
import type { VllmOps } from "./vllm-ops";
import type { InstallationEntry } from "./catalog";

// ---------------------------------------------------------------------------
// Mocks: must be set up before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../../env", () => ({ env: {
  PORT: 4020,
  HOST: "0.0.0.0",
  XINITY_OLLAMA_ENDPOINT: "http://localhost:11434",
  DB_CONNECTION_URL: "postgres://localhost/test",
  STATE_DIR: "/tmp/test-state",
  CIDR_PREFIX: "10.0.0",
  SYNC_INTERVAL_MS: 60_000,
  INFOSERVER_URL: "http://localhost:8090",
  INFOSERVER_CACHE_TTL_MS: 0,
  VLLM_BACKEND: "docker",
  VLLM_ENV_DIR: "/tmp/vllm-env",
  VLLM_TEMPLATE_UNIT_PATH: "/tmp/vllm-template",
  VLLM_PATH: "",
  VLLM_DOCKER_IMAGE: "vllm/vllm-openai:latest",
  VLLM_HF_CACHE_DIR: "/tmp/hf-cache",
  VLLM_TRITON_CACHE_DIR: "/tmp/triton-cache",
  VLLM_HEALTH_TIMEOUT_MS: 500,
  VLLM_HEALTH_POLL_INTERVAL_MS: 50,
  VLLM_MAX_RESTART_COUNT: 3,
  LOG_LEVEL: "silent",
  LOG_DIR: undefined,
}}));

// Mock DB: tracks insert and select calls
const mockOnConflictDoUpdate = mock(() => Promise.resolve());
const mockInsertValues = mock(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockInsert = mock(() => ({ values: mockInsertValues }));

const mockSelectWhere = mock(() => Promise.resolve([] as unknown[]));
const mockSelectFrom = mock(() => ({ where: mockSelectWhere }));
const mockSelect = mock(() => ({ from: mockSelectFrom }));

mock.module("../../db/connection", () => ({
  getDB: () => ({
    insert: mockInsert,
    select: mockSelect,
  }),
  listen: mock(),
}));

mock.module("../../logger", () => ({
  rootLogger: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}));

type MockEntry = InstallationEntry;

function catalogEntry(engineSpecifier: string, overrides: Partial<MockEntry> = {}): MockEntry {
  return { engineSpecifier, type: "chat", tags: [], args: [], downloadFilter: [], ...overrides };
}

const mockResolveEntry = mock<(specifier: string, engine: string) => Promise<MockEntry | undefined>>(
  (specifier) => Promise.resolve(catalogEntry(specifier)),
);

mock.module("./catalog", () => ({
  resolveInstallationEntry: mockResolveEntry,
}));

// Mock the statekeeper hardware profile
mock.module("../statekeeper", () => ({
  getAuthToken: () => "mock-token",
  getHardwareProfile: () => Promise.resolve({
    gpus: [{ vendor: "nvidia", name: "Test GPU", vramMb: 24576 }],
    gpuCount: 1,
    detectedCapacityGb: 24,
    physicalCapacityGb: 24,
    source: "nvidia",
  }),
}));

// Mock the native HF downloader (no-op in tests)
mock.module("./vllm-download", () => ({
  downloadModel: mock(() => Promise.resolve()),
}));

mock.module("./page-cache", () => ({
  dropPageCache: mock(() => Promise.resolve()),
}));

const { syncVllmInstallations$, computeGpuUtilization } = await import("./vllm");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstallation(specifier: string, id: string = crypto.randomUUID(), port = 8080) {
  return {
    id,
    nodeId: "node-1",
    specifier,
    estCapacity: 16,
    kvCacheCapacity: 4,
    port,
    driver: "vllm" as const,
    settings: { version: 1 as const },
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createMockOps(overrides: Partial<VllmOps> = {}): VllmOps {
  return {
    ensureSetup: mock(() => Promise.resolve()),
    listRunning: mock(() => Promise.resolve([] as string[])),
    start: mock(() => Promise.resolve()),
    stop: mock(() => Promise.resolve()),
    checkHealth: mock(() => Promise.resolve(false)),
    isAlive: mock(() => Promise.resolve(true)),
    getLogs: mock(() => Promise.resolve("")),
    getRestartCount: mock(() => Promise.resolve(0)),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncVllmInstallations$", () => {
  beforeEach(() => {
    mockInsert.mockClear();
    mockInsertValues.mockClear();
    mockOnConflictDoUpdate.mockClear();
    mockSelect.mockClear();
    mockSelectFrom.mockClear();
    mockSelectWhere.mockImplementation(() => Promise.resolve([]));
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier)));
  });

  test("completes with no changes when desired matches running", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("llama3", id);
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([id])),
      checkHealth: mock(() => Promise.resolve(true)),
    });

    // Reconcile will find the id running, DB state query returns "ready"
    mockSelectWhere.mockImplementation(() =>
      Promise.resolve([{ id, lifecycleState: "ready", progress: null, errorMessage: null, statusMessage: null, failureLogs: null, createdAt: new Date(), updatedAt: new Date() }]),
    );

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    expect(ops.stop).not.toHaveBeenCalled();
    expect(ops.start).not.toHaveBeenCalled();
  });

  test("removes stale containers not in desired list", async () => {
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve(["stale-1", "stale-2"])),
    });

    await firstValueFrom(syncVllmInstallations$([], ops));

    expect(ops.stop).toHaveBeenCalledTimes(2);
  });

  test("starts new containers for desired installations not yet running", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("new-model", id, 9090);
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    expect(ops.start).toHaveBeenCalledTimes(1);
    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    expect(startCall[0]).toBe(id);
    expect(startCall[1]).toMatchObject({
      model: "new-model",
      port: 9090,
    });
  });

  test("passes trustRemoteCode when model has custom_code tag", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("custom-model", id, 9091);
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { tags: ["custom_code"] })));
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    expect(startCall[1].trustRemoteCode).toBe(true);
  });

  test("adds --enable-auto-tool-choice when model has tools tag", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("tool-model", id, 9092);
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { tags: ["tools"] })));
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    expect(startCall[1].extraArgs).toContain("--enable-auto-tool-choice");
  });

  test("marks installation as failed when container dies during health poll", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("dying-model", id, 9093);
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(false)),
      isAlive: mock(() => Promise.resolve(false)), // container died
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    // Should have written a "failed" state to DB
    const stateWrites = mockInsertValues.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const failedWrite = stateWrites.find(
      (call) => call[0]?.lifecycleState === "failed",
    );
    expect(failedWrite).toBeDefined();
  });

  test("reconciles running container with stale failed DB state to installing", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("stale-model", id, 9094);
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([id])),
      checkHealth: mock(() => Promise.resolve(false)), // not yet healthy
      isAlive: mock(() => Promise.resolve(true)), // but alive
    });

    // DB says it's "failed" but container is running
    mockSelectWhere.mockImplementation(() =>
      Promise.resolve([{
        id,
        lifecycleState: "failed",
        progress: null,
        errorMessage: "Previous error",
        statusMessage: null,
        failureLogs: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }]),
    );

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    // Should have corrected the state to "installing"
    const stateWrites = mockInsertValues.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const installingWrite = stateWrites.find(
      (call) => call[0]?.lifecycleState === "installing",
    );
    expect(installingWrite).toBeDefined();
  });

  test("captures logs when container dies during health poll", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("dying-model-logs", id, 9096);
    const sampleLogs = "CUDA error: out of memory\nFailed to allocate 16GB";
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(false)),
      isAlive: mock(() => Promise.resolve(false)),
      getLogs: mock(() => Promise.resolve(sampleLogs)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    expect(ops.getLogs).toHaveBeenCalled();
    const stateWrites = mockInsertValues.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const failedWrite = stateWrites.find(
      (call) => call[0]?.lifecycleState === "failed",
    );
    expect(failedWrite).toBeDefined();
    expect(failedWrite![0].failureLogs).toBe(sampleLogs);
  });

  test("reconciles dead container to failed state with logs", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("dead-model", id, 9095);
    const sampleLogs = "RuntimeError: Model loading failed";
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([id])),
      checkHealth: mock(() => Promise.resolve(false)),
      isAlive: mock(() => Promise.resolve(false)), // container dead
      getLogs: mock(() => Promise.resolve(sampleLogs)),
    });

    // DB says it's "installing" but container is dead
    mockSelectWhere.mockImplementation(() =>
      Promise.resolve([{
        id,
        lifecycleState: "installing",
        progress: null,
        errorMessage: null,
        statusMessage: null,
        failureLogs: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }]),
    );

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    expect(ops.getLogs).toHaveBeenCalled();
    const stateWrites = mockInsertValues.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const failedWrite = stateWrites.find(
      (call) => call[0]?.lifecycleState === "failed",
    );
    expect(failedWrite).toBeDefined();
    expect(failedWrite![0].failureLogs).toBe(sampleLogs);
  });

  test("marks failed and stops container on crash-loop during health poll", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("crashloop-model", id, 9097);
    const sampleLogs = "torch.cuda.OutOfMemoryError: CUDA out of memory";
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(false)),
      isAlive: mock(() => Promise.resolve(true)),
      getRestartCount: mock(() => Promise.resolve(5)),
      getLogs: mock(() => Promise.resolve(sampleLogs)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const stateWrites = mockInsertValues.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const failedWrite = stateWrites.find(
      (call) => call[0]?.lifecycleState === "failed",
    );
    expect(failedWrite).toBeDefined();
    expect(failedWrite![0].failureLogs).toBe(sampleLogs);
    // Fatal pattern match overrides the raw crash-loop message with a user-friendly label
    expect((failedWrite![0].errorMessage as string)).toContain("GPU out of memory");
    expect(ops.stop).toHaveBeenCalled();
  });

  test("marks failed on fatal log pattern after first restart", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("fatal-model", id, 9098);
    const sampleLogs = "PermissionError: [Errno 13] triton cache /data/triton-cache";
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(false)),
      isAlive: mock(() => Promise.resolve(true)),
      getRestartCount: mock(() => Promise.resolve(1)),
      getLogs: mock(() => Promise.resolve(sampleLogs)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const stateWrites = mockInsertValues.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const failedWrite = stateWrites.find(
      (call) => call[0]?.lifecycleState === "failed",
    );
    expect(failedWrite).toBeDefined();
    expect((failedWrite![0].errorMessage as string)).toContain("Triton cache permission error");
    expect(failedWrite![0].failureLogs).toBe(sampleLogs);
  });

  test("stops container when marking as failed on container death", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("stop-on-fail-model", id, 9099);
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(false)),
      isAlive: mock(() => Promise.resolve(false)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    expect(ops.stop).toHaveBeenCalled();
  });

  test("skips already-failed installations on sync", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("failed-model", id, 9100);
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
    });

    // DB says this installation is already "failed"
    mockSelectWhere.mockImplementation(() =>
      Promise.resolve([{
        id,
        lifecycleState: "failed",
        progress: null,
        errorMessage: "Previous crash-loop",
        statusMessage: null,
        failureLogs: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }]),
    );

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    expect(ops.start).not.toHaveBeenCalled();
  });

  test("adds --runner pooling for embedding models", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("embed-model", id, 9102);
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { type: "embedding" })));
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    expect(startCall[1].extraArgs).toContain("--runner");
    expect(startCall[1].extraArgs).toContain("pooling");
  });

  test("adds --runner pooling for rerank models", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("rerank-model", id, 9103);
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { type: "rerank" })));
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    expect(startCall[1].extraArgs).toContain("--runner");
    expect(startCall[1].extraArgs).toContain("pooling");
  });

  test("does not add --runner pooling for chat models", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("chat-model", id, 9104);
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier)));
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    expect(startCall[1].extraArgs).not.toContain("--runner");
  });

  test("does not warm up transcription models with a chat completion", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      const id = crypto.randomUUID();
      const inst = makeInstallation("whisper-model", id, 9106);
      mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { type: "transcription" })));
      const ops = createMockOps({
        listRunning: mock(() => Promise.resolve([])),
        checkHealth: mock(() => Promise.resolve(true)),
        isAlive: mock(() => Promise.resolve(true)),
      });

      await firstValueFrom(syncVllmInstallations$([inst], ops));

      expect(ops.start).toHaveBeenCalled();
      const warmupCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes("/v1/chat/completions"));
      expect(warmupCalls).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("passes settings through to the start config", async () => {
    const id = crypto.randomUUID();
    const settings = { version: 1 as const, maxAudioInputDurationS: 1200, maxAudioInputFileSizeMB: 50 };
    const inst = { ...makeInstallation("whisper-model", id, 9107), settings };
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { type: "transcription" })));
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    expect(startCall[1].settings).toEqual(settings);
  });

  test("passes bare settings when installation has no audio overrides", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("whisper-model", id, 9108);
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { type: "transcription" })));
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    expect(startCall[1].settings).toEqual({ version: 1 });
  });

  test("uses the engine specifier from the catalog rather than the specifier itself", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("canonical-x", id, 9105);
    mockResolveEntry.mockImplementation(() => Promise.resolve(catalogEntry("real-vllm-name")));
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    expect(startCall[1].model).toBe("real-vllm-name");
  });

  test("aborts the installation when no catalog resolves the specifier for vllm", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("ollama-only-model", id, 9106);
    mockResolveEntry.mockImplementation(() => Promise.resolve(undefined));
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    expect(ops.start).not.toHaveBeenCalled();
  });

  test("reconciles crash-looping container to failed and stops it", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("reconcile-crashloop", id, 9101);
    const sampleLogs = "RuntimeError: CUDA error: device-side assert triggered";
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([id])),
      checkHealth: mock(() => Promise.resolve(false)),
      isAlive: mock(() => Promise.resolve(true)),
      getRestartCount: mock(() => Promise.resolve(5)),
      getLogs: mock(() => Promise.resolve(sampleLogs)),
    });

    // DB says it's "installing" but container is crash-looping
    mockSelectWhere.mockImplementation(() =>
      Promise.resolve([{
        id,
        lifecycleState: "installing",
        progress: null,
        errorMessage: null,
        statusMessage: null,
        failureLogs: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }]),
    );

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const stateWrites = mockInsertValues.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const failedWrite = stateWrites.find(
      (call) => call[0]?.lifecycleState === "failed",
    );
    expect(failedWrite).toBeDefined();
    expect((failedWrite![0].errorMessage as string)).toContain("crash-looping");
    expect(failedWrite![0].failureLogs).toBe(sampleLogs);
    expect(ops.stop).toHaveBeenCalled();
  });

  test("calculates gpuMemoryUtilization as requiredGb / physicalCapacityGb", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("mem-test-model", id, 9100);
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    const util = startCall[1].gpuMemoryUtilization as number;
    expect(util).toBeCloseTo((16 * 1.1) / 24, 4);
  });

  test("caps gpuMemoryUtilization at MAX_GPU_UTILIZATION (0.90)", () => {
    const util = computeGpuUtilization(
      { specifier: "cap-model", estCapacity: 22 },
      { gpuCount: 1, detectedCapacityGb: 24, physicalCapacityGb: 24 },
    );
    expect(util).toBe(0.90);
  });

  test("caps gpuMemoryUtilization at unified-memory headroom fraction", () => {
    const util = computeGpuUtilization(
      { specifier: "large-unified-model", estCapacity: 100 },
      { gpuCount: 1, detectedCapacityGb: 107, physicalCapacityGb: 120 },
    );
    expect(util).toBeCloseTo(107 / 120, 4);
  });

  test("allocates exactly requiredGb for a small model on unified memory", () => {
    const util = computeGpuUtilization(
      { specifier: "small-unified-model", estCapacity: 16 },
      { gpuCount: 1, detectedCapacityGb: 107, physicalCapacityGb: 120 },
    );
    expect(util).toBeCloseTo((16 * 1.1) / 120, 4);
  });
});
