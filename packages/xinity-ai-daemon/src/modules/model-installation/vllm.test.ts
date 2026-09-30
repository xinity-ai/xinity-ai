import { describe, test, expect, mock, beforeEach, afterAll, spyOn } from "bun:test";
import { mockDaemonConfig } from "../../mock-config";
import { firstValueFrom } from "rxjs";
import type { VllmOps } from "./vllm-ops";
import type { InstallationEntry } from "./catalog";

// ---------------------------------------------------------------------------
// Mocks: must be set up before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../../config", () => ({ config: mockDaemonConfig({
  CIDR_PREFIX: "10.0.0",
  INFOSERVER_URL: "http://localhost:8090",
  INFOSERVER_CACHE_TTL_MS: "0",
  VLLM_BACKEND: "docker",
  VLLM_ENV_DIR: "/tmp/vllm-env",
  VLLM_TEMPLATE_UNIT_PATH: "/tmp/vllm-template",
  VLLM_DOCKER_IMAGE: "vllm/vllm-openai:latest",
  VLLM_HF_CACHE_DIR: "/tmp/hf-cache",
  VLLM_TRITON_CACHE_DIR: "/tmp/triton-cache",
  VLLM_HEALTH_TIMEOUT_MS: "500",
  VLLM_HEALTH_POLL_INTERVAL_MS: "50",
}) }));

type StateCall = [string, string, Record<string, unknown> | undefined];
const stateWrites: StateCall[] = [];

const mockLocalStates = new Map<string, { lifecycleState: string }>();

const mockUpdateState = mock((id: string, state: string, opts?: Record<string, unknown>) => {
  stateWrites.push([id, state, opts]);
  return Promise.resolve();
});

mock.module("./state", () => ({
  updateInstallationState: mockUpdateState,
  getLocalInstallationState: (id: string) => mockLocalStates.get(id),
  getLocalInstallationStates: (ids: string[]) => {
    const result = new Map<string, { lifecycleState: string }>();
    for (const id of ids) {
      const entry = mockLocalStates.get(id);
      if (entry) {
        result.set(id, entry);
      }
    }
    return result;
  },
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

mock.module("../statekeeper", () => ({
  getAuthToken: () => "mock-token",
  getHardwareProfile: () => Promise.resolve({
    gpus: [{ vendor: "nvidia", name: "Test GPU", vramMb: 24576 }],
    gpuCount: 1,
    detectedCapacityGb: 24,
    physicalCapacityGb: 24,
    systemRamMb: 131072,
    source: "nvidia",
  }),
}));

const vllmDownload = await import("./vllm-download");
const downloadModelSpy = spyOn(vllmDownload, "downloadModel").mockResolvedValue(undefined);

mock.module("./page-cache", () => ({
  dropPageCache: mock(() => Promise.resolve()),
}));

const { syncVllmInstallations$, computeGpuUtilization, buildVllmExtraArgs, concurrencyCap, matchFatalPattern, perCardSizing } = await import("./vllm");
afterAll(() => {
  downloadModelSpy.mockRestore();
});

const nvidiaCard = (vramMb: number) => ({ vendor: "nvidia" as const, name: "Test GPU", vramMb });

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
    gpuUuids: [],
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
    stateWrites.length = 0;
    mockUpdateState.mockClear();
    mockLocalStates.clear();
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier)));
  });

  test("completes with no changes when desired matches running", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("llama3", id);
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([id])),
      checkHealth: mock(() => Promise.resolve(true)),
    });

    mockLocalStates.set(id, { lifecycleState: "ready" });

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
      isAlive: mock(() => Promise.resolve(false)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const failedWrite = stateWrites.find(([, state]) => state === "failed");
    expect(failedWrite).toBeDefined();
  });

  test("reconciles running container with stale failed state to installing", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("stale-model", id, 9094);
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([id])),
      checkHealth: mock(() => Promise.resolve(false)),
      isAlive: mock(() => Promise.resolve(true)),
    });

    mockLocalStates.set(id, { lifecycleState: "failed" });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const installingWrite = stateWrites.find(([, state]) => state === "installing");
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
    const failedWrite = stateWrites.find(([, state]) => state === "failed");
    expect(failedWrite).toBeDefined();
    expect(failedWrite![2]?.failureLogs).toBe(sampleLogs);
  });

  test("reconciles dead container to failed state with logs", async () => {
    const id = crypto.randomUUID();
    const inst = makeInstallation("dead-model", id, 9095);
    const sampleLogs = "RuntimeError: Model loading failed";
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([id])),
      checkHealth: mock(() => Promise.resolve(false)),
      isAlive: mock(() => Promise.resolve(false)),
      getLogs: mock(() => Promise.resolve(sampleLogs)),
    });

    mockLocalStates.set(id, { lifecycleState: "installing" });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    expect(ops.getLogs).toHaveBeenCalled();
    const failedWrite = stateWrites.find(([, state]) => state === "failed");
    expect(failedWrite).toBeDefined();
    expect(failedWrite![2]?.failureLogs).toBe(sampleLogs);
  });

  test("fails an installation assigned to a card the node does not report, before starting it", async () => {
    const inst = { ...makeInstallation("missing-card-model", crypto.randomUUID(), 9096), gpuUuids: ["GPU-gone"] };
    const ops = createMockOps({ listRunning: mock(() => Promise.resolve([])) });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const failedWrite = stateWrites.find(([, state]) => state === "failed");
    expect((failedWrite![2]?.errorMessage as string)).toBe("Assigned GPU GPU-gone is not on this node");
    expect(ops.start).not.toHaveBeenCalled();
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

    const failedWrite = stateWrites.find(([, state]) => state === "failed");
    expect(failedWrite).toBeDefined();
    expect(failedWrite![2]?.failureLogs).toBe(sampleLogs);
    expect((failedWrite![2]?.errorMessage as string)).toContain("GPU out of memory");
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

    const failedWrite = stateWrites.find(([, state]) => state === "failed");
    expect(failedWrite).toBeDefined();
    expect((failedWrite![2]?.errorMessage as string)).toContain("Triton cache permission error");
    expect(failedWrite![2]?.failureLogs).toBe(sampleLogs);
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

    mockLocalStates.set(id, { lifecycleState: "failed" });

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

    mockLocalStates.set(id, { lifecycleState: "installing" });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    const failedWrite = stateWrites.find(([, state]) => state === "failed");
    expect(failedWrite).toBeDefined();
    expect((failedWrite![2]?.errorMessage as string)).toContain("crash-looping");
    expect(failedWrite![2]?.failureLogs).toBe(sampleLogs);
    expect(ops.stop).toHaveBeenCalled();
  });

  test("sizes weights, cache and overhead in GiB against the card", async () => {
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
    expect(util).toBeCloseTo(0.83656, 4);
  });

  test("caps gpuMemoryUtilization at MAX_GPU_UTILIZATION (0.90)", () => {
    const util = computeGpuUtilization(
      { specifier: "cap-model", weightGb: 20, kvCacheGb: 4 },
      { gpus: [nvidiaCard(24576)], gpuCount: 1, systemRamMb: 131072, detectedCapacityGb: 24, physicalCapacityGb: 24 },
    );
    expect(util).toBe(0.90);
  });

  test("caps gpuMemoryUtilization at unified-memory headroom fraction", () => {
    const util = computeGpuUtilization(
      { specifier: "large-unified-model", weightGb: 96, kvCacheGb: 4 },
      { gpus: [nvidiaCard(0)], gpuCount: 1, systemRamMb: 122880, detectedCapacityGb: 107, physicalCapacityGb: 120 },
    );
    expect(util).toBeCloseTo(107 / 120, 4);
  });

  test("sizes a small model on unified memory against the whole of system RAM", () => {
    const util = computeGpuUtilization(
      { specifier: "small-unified-model", weightGb: 12, kvCacheGb: 4 },
      { gpus: [nvidiaCard(0)], gpuCount: 1, systemRamMb: 122880, detectedCapacityGb: 107, physicalCapacityGb: 120 },
    );
    expect(util).toBeCloseTo(0.16731, 4);
  });

  test("sizes against the card the installation is pinned to", () => {
    const mixed = {
      gpus: [{ ...nvidiaCard(49152), uuid: "GPU-big" }, { ...nvidiaCard(24576), uuid: "GPU-small" }],
      gpuCount: 2, systemRamMb: 131072, detectedCapacityGb: 72, physicalCapacityGb: 72,
    };
    const sizing = { specifier: "pinned-model", weightGb: 12, kvCacheGb: 4 };
    expect(computeGpuUtilization({ ...sizing, gpuUuids: ["GPU-small"] }, mixed)).toBeCloseTo(0.83656, 4);
    expect(computeGpuUtilization({ ...sizing, gpuUuids: [] }, mixed)).toBeCloseTo(0.83656 / 2, 4);
  });

  test("sizes against the instance's card, not the node's summed VRAM", () => {
    const util = computeGpuUtilization(
      { specifier: "two-card-node-model", weightGb: 12, kvCacheGb: 4 },
      { gpus: [nvidiaCard(24576), nvidiaCard(24576)], gpuCount: 2, systemRamMb: 131072, detectedCapacityGb: 48, physicalCapacityGb: 48 },
    );
    expect(util).toBeCloseTo(0.83656, 4);
  });

  test("takes an entry's measured overhead in place of the estimate", () => {
    const util = computeGpuUtilization(
      { specifier: "measured-model", weightGb: 12, kvCacheGb: 4, overheadGb: 2 },
      { gpus: [nvidiaCard(24576)], gpuCount: 1, systemRamMb: 131072, detectedCapacityGb: 24, physicalCapacityGb: 24 },
    );
    expect(util).toBeCloseTo(18 / 1.073741824 / 24, 5);
  });

  test("covers the tightest measured footprint by more than run-to-run variance", () => {
    // baidu/Unlimited-OCR on a GB10: 6.24 GiB resident weights and 3.42 GiB measured overhead,
    // the smallest margin of twelve measured loads. Overhead varies ~0.2 GiB between identical runs.
    const kvCacheGb = 2.02;
    const util = computeGpuUtilization(
      { specifier: "unlimited-ocr-vllm", weightGb: 6.70, kvCacheGb },
      { gpus: [nvidiaCard(0)], gpuCount: 1, systemRamMb: 124549, detectedCapacityGb: 109, physicalCapacityGb: 121 },
    )!;
    const footprintGib = 6.24 + kvCacheGb / 1.073741824 + 3.42;
    expect(util * (124549 / 1024) - footprintGib).toBeGreaterThan(0.2);
  });
});

describe("concurrencyCap", () => {
  const gpus = [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 4090", vramMb: 24576 }];
  const sizing = { weightGb: 14, minKvCacheGb: 4, maxContextLength: 32768, weightBits: 16, kvBytesPerToken: 131072 };

  test("declines for a legacy entry, which states no sizing at all", () => {
    expect(concurrencyCap(undefined, gpus, 8)).toBeUndefined();
  });

  test("declines when the entry states no kv cost per token, rather than guessing one", () => {
    const { kvBytesPerToken, ...withoutPerToken } = sizing;
    expect(concurrencyCap(withoutPerToken, gpus, 8)).toBeUndefined();
  });

  test("stays inside what the allocated cache holds, so vllm never rejects the cap", () => {
    const cap = concurrencyCap(sizing, gpus, 8)!;
    const cacheHolds = Math.floor((8 * 1e9) / (131072 * 4096));

    expect(cap).toBeLessThanOrEqual(cacheHolds);
    expect(cap).toBeGreaterThan(0);
  });

  test("charges a hybrid model for its per-sequence state, lowering the cap", () => {
    // Few full-attention layers, so KV per token is small and the fixed state dominates.
    // The cache is tight on purpose: state only shows where the cache floor is what binds.
    const attentionOnly = { ...sizing, kvBytesPerToken: 24576 };
    const hybrid = { ...attentionOnly, stateBytesPerSequence: 20_000_000 };

    expect(concurrencyCap(hybrid, gpus, 3)!).toBeLessThan(concurrencyCap(attentionOnly, gpus, 3)!);
  });
});

describe("buildVllmExtraArgs", () => {
  test("caps concurrency when an estimate exists", () => {
    expect(buildVllmExtraArgs(undefined, false, [], 17)).toEqual(["--max-num-seqs", "17"]);
  });

  test("leaves vllm's default alone without an estimate", () => {
    expect(buildVllmExtraArgs(undefined, false, [])).toEqual([]);
  });

  test("yields to an entry that sets the flag itself, rather than passing it twice", () => {
    expect(buildVllmExtraArgs(undefined, false, ["--max-num-seqs", "256"], 17))
      .toEqual(["--max-num-seqs", "256"]);
  });

  test("keeps the runner and tool flags it already derived", () => {
    expect(buildVllmExtraArgs("embedding", true, ["--x"], 8))
      .toEqual(["--runner", "pooling", "--enable-auto-tool-choice", "--max-num-seqs", "8", "--x"]);
  });
});

describe("matchFatalPattern", () => {
  test("names a cache too small for one full-context request, in vllm's own wording", () => {
    const logs = "ValueError: To serve at least one request with the model's max seq len (32768), "
      + "(2.01 GiB KV cache is needed, which is larger than the available KV cache memory (1.50 GiB). "
      + "Based on the available memory, the estimated maximum model length is 24448. "
      + "Try increasing `gpu_memory_utilization` or decreasing `max_model_len` when initializing the engine.";
    expect(matchFatalPattern(logs)).toBe("KV cache too small for one full-context request");
  });

  test("names a cache with no memory at all, in vllm's own wording", () => {
    const logs = "ValueError: No available memory for the cache blocks. "
      + "Try increasing `gpu_memory_utilization` when initializing the engine.";
    expect(matchFatalPattern(logs)).toBe("No GPU memory left for the KV cache");
  });
});

describe("perCardSizing", () => {
  const installation = { specifier: "qwen3.8-27b-vllm", estCapacity: 42, kvCacheCapacity: 16 };
  const sizing = { weightGb: 26, minKvCacheGb: 16, maxContextLength: 262144, attentionHeads: 24, kvHeads: 4 };

  test("leaves a single-card installation as the scheduler sized it", () => {
    expect(perCardSizing(installation, sizing, 1)).toEqual({ weightGb: 26, kvCacheGb: 16 });
  });

  test("gives each card its share of weights and cache", () => {
    expect(perCardSizing(installation, sizing, 2)).toEqual({ weightGb: 13, kvCacheGb: 8 });
  });

  test("keeps one kv head's worth of cache per card once the heads run out", () => {
    expect(perCardSizing(installation, sizing, 8)).toEqual({ weightGb: 3.25, kvCacheGb: 4 });
  });

  test("refuses a split the model's heads do not allow", () => {
    expect(() => perCardSizing(installation, sizing, 3)).toThrow("qwen3.8-27b-vllm cannot run tensor parallel across 3 cards");
    expect(() => perCardSizing(installation, undefined, 2)).toThrow("cannot run tensor parallel across 2 cards");
  });
});
