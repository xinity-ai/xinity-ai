import { describe, test, expect, mock, beforeEach } from "bun:test";
import { firstValueFrom } from "rxjs";
import type { VllmOps } from "./vllm-ops";
import { installationLookup } from "xinity-infoserver";

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
  INFOSERVER_URL: "http://localhost:8393",
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

// Mock the infoserver client
const mockHasTag = mock<(specifier: string, tag: string) => Promise<boolean>>(
  () => Promise.resolve(false),
);
const mockResolveDriverArgs = mock<(specifier: string) => Promise<string[]>>(
  () => Promise.resolve([]),
);
type Lookup = { kind: "canonical"; specifier: string } | { kind: "legacy"; providerModel: string };
const lookupValue = (l: Lookup) => l.kind === "canonical" ? l.specifier : l.providerModel;
const mockFetchModel = mock<(lookup: Lookup) => Promise<{ type?: string; providers: { vllm?: string; ollama?: string } } | undefined>>(
  (lookup) => Promise.resolve({ type: "chat", providers: { vllm: lookupValue(lookup) } }),
);

mock.module("xinity-infoserver", () => ({
  createInfoserverClient: () => ({
    hasTag: mockHasTag,
    resolveDriverArgs: mockResolveDriverArgs,
    fetchModel: mockFetchModel,
  }),
  installationLookup,
}));

// Mock the statekeeper hardware profile
mock.module("../statekeeper", () => ({
  getAuthToken: () => "mock-token",
  getHardwareProfile: () => Promise.resolve({
    gpus: [{ vendor: "nvidia", name: "Test GPU", vramMb: 24576 }],
    gpuCount: 1,
    detectedCapacityGb: 24,
    source: "nvidia",
  }),
}));

// Mock free memory query (20 GiB free on a 24 GiB GPU)
const mockGetFreeMemoryMb = mock(() => Promise.resolve(20480 as number | null));
mock.module("../hardware-detect", () => ({
  getFreeMemoryMb: mockGetFreeMemoryMb,
}));

// Mock the native HF downloader (no-op in tests)
mock.module("./vllm-download", () => ({
  downloadModel: mock(() => Promise.resolve()),
}));

const { syncVllmInstallations$ } = await import("./vllm");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstallation(model: string, id: string = crypto.randomUUID(), port = 8080) {
  return {
    id,
    nodeId: "node-1",
    specifier: null,
    model,
    estCapacity: 16,
    kvCacheCapacity: 4,
    port,
    driver: "vllm" as const,
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
    mockHasTag.mockImplementation(() => Promise.resolve(false));
    mockResolveDriverArgs.mockImplementation(() => Promise.resolve([]));
    mockFetchModel.mockImplementation((lookup) => Promise.resolve({ type: "chat", providers: { vllm: lookupValue(lookup) } }));
    mockGetFreeMemoryMb.mockImplementation(() => Promise.resolve(20480));
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
    mockHasTag.mockImplementation((_model, tag) =>
      Promise.resolve(tag === "custom_code"),
    );
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
    mockHasTag.mockImplementation((_model, tag) =>
      Promise.resolve(tag === "tools"),
    );
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
    mockFetchModel.mockImplementation((lookup) => Promise.resolve({ type: "embedding", providers: { vllm: lookupValue(lookup) } }));
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
    mockFetchModel.mockImplementation((lookup) => Promise.resolve({ type: "rerank", providers: { vllm: lookupValue(lookup) } }));
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
    mockFetchModel.mockImplementation((lookup) => Promise.resolve({ type: "chat", providers: { vllm: lookupValue(lookup) } }));
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    expect(startCall[1].extraArgs).not.toContain("--runner");
  });

  test("uses providers.vllm from the catalog rather than the installation row's model column", async () => {
    const id = crypto.randomUUID();
    const inst = { ...makeInstallation("legacy-stale-name", id, 9105), specifier: "canonical-x" };
    mockFetchModel.mockImplementation(() => Promise.resolve({ type: "chat", providers: { vllm: "real-vllm-name" } }));
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    expect(startCall[1].model).toBe("real-vllm-name");
  });

  test("aborts the installation when the catalog has no vllm provider for the chosen driver", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("ollama-only-model", id, 9106);
    mockFetchModel.mockImplementation(() => Promise.resolve({ type: "chat", providers: { ollama: "ollama-only-model" } }));
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

  test("calculates gpuMemoryUtilization from free VRAM, not total", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("mem-test-model", id, 9100);
    // estCapacity=16, totalCapacity=24, freeMemory=20480 MB (20 GiB)
    // requiredGb = 16 * 1.1 = 17.6
    // maxClaimGb = max(20 - 1, 17.6) = 19
    // utilization = min(19 / 24, 0.90) = min(0.7917, 0.90) ≈ 0.792
    mockGetFreeMemoryMb.mockImplementation(() => Promise.resolve(20480));
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    const util = startCall[1].gpuMemoryUtilization as number;
    expect(util).toBeCloseTo(19 / 24, 2);
  });

  test("falls back to estCapacity-based calculation when free memory unavailable", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("fallback-model", id, 9101);
    // estCapacity=16, totalCapacity=24, freeMemory=null (query failed)
    // requiredGb = 16 * 1.1 = 17.6
    // utilization = min(17.6 / 24, 0.90) = min(0.733, 0.90) ≈ 0.733
    mockGetFreeMemoryMb.mockImplementation(() => Promise.resolve(null));
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    const util = startCall[1].gpuMemoryUtilization as number;
    expect(util).toBeCloseTo((16 * 1.1) / 24, 2);
  });

  test("caps gpuMemoryUtilization at 0.90", async () => {
    const id = crypto.randomUUID();
    // High free memory — without the cap, utilization would exceed 0.90
    const inst = makeInstallation("cap-model", id, 9102);
    // freeMemory = 23552 MB (23 GiB), total = 24 GiB
    // maxClaimGb = max(23 - 1, 17.6) = 22
    // utilization = min(22 / 24, 0.90) = min(0.917, 0.90) = 0.90
    mockGetFreeMemoryMb.mockImplementation(() => Promise.resolve(23552));
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([])),
      checkHealth: mock(() => Promise.resolve(true)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const startCall = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    const util = startCall[1].gpuMemoryUtilization as number;
    expect(util).toBe(0.90);
  });
});
