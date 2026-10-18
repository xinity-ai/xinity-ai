import { describe, test, expect, mock, beforeEach, afterAll, spyOn } from "bun:test";
import { mockDaemonConfig } from "../../mock-config";
import { firstValueFrom } from "rxjs";
import type { VllmOps } from "./vllm-ops";
import type { InstallationEntry } from "./catalog";
import type { GroupStage } from "common-env";

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

const mockLocalStates = new Map<string, { lifecycleState: string; statusMessage?: string; groupGeneration?: number }>();

const mockUpdateState = mock((id: string, state: string, opts?: Record<string, unknown>) => {
  stateWrites.push([id, state, opts]);
  return Promise.resolve();
});

mock.module("./state", () => ({
  updateInstallationState: mockUpdateState,
  getLocalInstallationState: (id: string) => mockLocalStates.get(id),
  getLocalInstallationStates: (ids: string[]) => {
    const result = new Map<string, { lifecycleState: string; statusMessage?: string; groupGeneration?: number }>();
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

let mockHostMemoryGb: number | undefined;

mock.module("../statekeeper", () => ({
  getAuthToken: () => "mock-token",
  getHardwareProfile: () => Promise.resolve({
    gpus: [{ vendor: "nvidia", name: "Test GPU", vramMb: 24576 }],
    gpuCount: 1,
    detectedCapacityGb: 24,
    physicalCapacityGb: 24,
    systemRamMb: 131072,
    hostMemoryGb: mockHostMemoryGb,
    source: "nvidia",
  }),
}));

const vllmDownload = await import("./vllm-download");
const downloadModelSpy = spyOn(vllmDownload, "downloadModel").mockResolvedValue(undefined);
const largestWeightFileSpy = spyOn(vllmDownload, "largestWeightFileBytes").mockResolvedValue(0);

mock.module("./page-cache", () => ({
  dropPageCache: mock(() => Promise.resolve()),
}));

const mockAddressInUse = mock((_address: string) => Promise.resolve(false));
const realCouplingNetwork = await import("./coupling-network");
mock.module("./coupling-network", () => ({
  ...realCouplingNetwork,
  addressInUse: mockAddressInUse,
  coupledPaths: () => Promise.resolve([{ subnet: "192.168.100.0/24", address: "192.168.100.1", interface: "enp1s0f0np0", rdmaDevice: "rocep1s0f0" }]),
}));

const { syncVllmInstallations$, computeGpuUtilization, fittedGpuGb, hostUseMessage, buildVllmExtraArgs, matchFatalPattern, perCardSizing } = await import("./vllm");
afterAll(() => {
  downloadModelSpy.mockRestore();
  largestWeightFileSpy.mockRestore();
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
    hostCapacity: null,
    maxNumSeqs: null,
    port,
    driver: "vllm" as const,
    settings: { version: 1 as const },
    gpuIds: [],
    group: null,
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
    memoryUse: mock(() => Promise.resolve(undefined)),
    wasOomKilled: mock(() => Promise.resolve(false)),
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

  test("names the host memory budget when the kernel killed it while loading", async () => {
    const inst = makeInstallation("oom-while-loading");
    const ops = createMockOps({
      isAlive: mock(() => Promise.resolve(false)),
      wasOomKilled: mock(() => Promise.resolve(true)),
    });

    await firstValueFrom(syncVllmInstallations$([inst], ops));

    expect(stateWrites.find(([, state]) => state === "failed")?.[2]?.errorMessage).toBe("Stopped while loading, over its host memory budget");
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
    const inst = { ...makeInstallation("missing-card-model", crypto.randomUUID(), 9096), gpuIds: ["GPU-gone"] };
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
      { specifier: "cap-model", gpuGb: fittedGpuGb(20, 4) },
      { gpus: [nvidiaCard(24576)], gpuCount: 1, systemRamMb: 131072, detectedCapacityGb: 24, physicalCapacityGb: 24 },
    );
    expect(util).toBe(0.90);
  });

  test("caps gpuMemoryUtilization at unified-memory headroom fraction", () => {
    const util = computeGpuUtilization(
      { specifier: "large-unified-model", gpuGb: fittedGpuGb(96, 4) },
      { gpus: [nvidiaCard(0)], gpuCount: 1, systemRamMb: 122880, detectedCapacityGb: 107, physicalCapacityGb: 120 },
    );
    expect(util).toBeCloseTo(107 / 120, 4);
  });

  test("sizes a small model on unified memory against the whole of system RAM", () => {
    const util = computeGpuUtilization(
      { specifier: "small-unified-model", gpuGb: fittedGpuGb(12, 4) },
      { gpus: [nvidiaCard(0)], gpuCount: 1, systemRamMb: 122880, detectedCapacityGb: 107, physicalCapacityGb: 120 },
    );
    expect(util).toBeCloseTo(0.16731, 4);
  });

  test("sizes against the card the installation is pinned to", () => {
    const mixed = {
      gpus: [{ ...nvidiaCard(49152), uuid: "GPU-big" }, { ...nvidiaCard(24576), uuid: "GPU-small" }],
      gpuCount: 2, systemRamMb: 131072, detectedCapacityGb: 72, physicalCapacityGb: 72,
    };
    const sizing = { specifier: "pinned-model", gpuGb: fittedGpuGb(12, 4) };
    expect(computeGpuUtilization({ ...sizing, gpuIds: ["GPU-small"] }, mixed)).toBeCloseTo(0.83656, 4);
    expect(computeGpuUtilization({ ...sizing, gpuIds: [] }, mixed)).toBeCloseTo(0.83656 / 2, 4);
  });

  test("sizes against the instance's card, not the node's summed VRAM", () => {
    const util = computeGpuUtilization(
      { specifier: "two-card-node-model", gpuGb: fittedGpuGb(12, 4) },
      { gpus: [nvidiaCard(24576), nvidiaCard(24576)], gpuCount: 2, systemRamMb: 131072, detectedCapacityGb: 48, physicalCapacityGb: 48 },
    );
    expect(util).toBeCloseTo(0.83656, 4);
  });

  test("covers the tightest measured footprint by more than run-to-run variance", () => {
    // baidu/Unlimited-OCR on a GB10: 6.24 GiB resident weights and 3.42 GiB measured overhead,
    // the smallest margin of twelve measured loads. Overhead varies ~0.2 GiB between identical runs.
    const kvCacheGb = 2.02;
    const util = computeGpuUtilization(
      { specifier: "unlimited-ocr-vllm", gpuGb: fittedGpuGb(6.70, kvCacheGb) },
      { gpus: [nvidiaCard(0)], gpuCount: 1, systemRamMb: 124549, detectedCapacityGb: 109, physicalCapacityGb: 121 },
    )!;
    const footprintGib = 6.24 + kvCacheGb / 1.073741824 + 3.42;
    expect(util * (124549 / 1024) - footprintGib).toBeGreaterThan(0.2);
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

  test("reads amd and intel failures in their runtimes' own wording", () => {
    expect(matchFatalPattern("torch.OutOfMemoryError: HIP out of memory. Tried to allocate 2.00 GiB.")).toBe("GPU out of memory");
    expect(matchFatalPattern("torch.OutOfMemoryError: XPU out of memory. Tried to allocate 2.00 GiB.")).toBe("GPU out of memory");
    expect(matchFatalPattern("hipErrorNoBinaryForGpu: Unable to find code object for all current devices!")).toBe("vLLM build has no kernels for this GPU");
    expect(matchFatalPattern("RuntimeError: HIP error: invalid device ordinal")).toBe("Invalid GPU device index");
    expect(matchFatalPattern("RuntimeError: UR_RESULT_ERROR_DEVICE_LOST")).toBe("GPU runtime error");
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
    const replicated = { ...installation, estCapacity: 58 };
    expect(perCardSizing(replicated, sizing, 8)).toEqual({ weightGb: 3.25, kvCacheGb: 4 });
  });

  test("leaves the weights the engine keeps in host memory off the cards", () => {
    expect(perCardSizing(installation, { ...sizing, hostWeightGb: 6 }, 2)).toEqual({ weightGb: 10, kvCacheGb: 8 });
  });

  test("derives the weights from the scheduler's figure for a legacy entry without sizing", () => {
    expect(perCardSizing(installation, undefined, 1)).toEqual({ weightGb: 26, kvCacheGb: 16 });
  });

  test("refuses a split the model's heads do not allow", () => {
    expect(() => perCardSizing(installation, sizing, 3)).toThrow("qwen3.8-27b-vllm cannot run tensor parallel across 3 cards");
    expect(() => perCardSizing(installation, undefined, 2)).toThrow("cannot run tensor parallel across 2 cards");
  });
});

describe("members of a group served across nodes", () => {
  const group = (stages: (GroupStage | null)[], generations: (number | null)[] = stages.map((stage) => (stage ? 1 : null))) => ({
    id: "group-1", rank: 1, size: 2, rendezvousPort: 29500, generation: 1,
    addresses: [{ subnet: "192.168.100.0/24", address: "192.168.100.253" }],
    masterAddresses: [{ subnet: "192.168.100.0/24", address: "192.168.100.254" }],
    members: stages.map((stage, rank) => ({ rank, stage, generation: generations[rank]! })),
  });
  const lastState = (id: string) => stateWrites.filter(([written]) => written === id).at(-1);

  const splittable = { weightGb: 12, minKvCacheGb: 4, maxContextLength: 8192, attentionHeads: 24, kvHeads: 4 };

  beforeEach(() => {
    stateWrites.length = 0;
    mockLocalStates.clear();
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { sizing: splittable })));
  });

  test("downloads and admits a member, then holds it until the other machines are admitted too, while a single installation starts", async () => {
    const member = { ...makeInstallation("waiting-member"), group: group([null, null]) };
    const single = makeInstallation("single-model");
    const ops = createMockOps({ checkHealth: mock(() => Promise.resolve(true)) });
    await firstValueFrom(syncVllmInstallations$([member, single], ops));
    expect((ops.start as ReturnType<typeof mock>).mock.calls.map(([id]) => id)).toEqual([single.id]);
    expect(stateWrites.find(([id]) => id === member.id)?.[2]?.groupStage).toBe("preparing");
    expect(lastState(member.id)).toEqual([member.id, "installing", { statusMessage: "Waiting for the other machines of its group", groupStage: "admitted", groupGeneration: 1 }]);
  });

  test("fails a member whose coupling address something else on its network already holds", async () => {
    mockAddressInUse.mockImplementationOnce(() => Promise.resolve(true));
    const member = { ...makeInstallation("crowded-member"), group: group([null, null]) };
    const ops = createMockOps({ checkHealth: mock(() => Promise.resolve(true)) });
    await firstValueFrom(syncVllmInstallations$([member], ops));
    expect(lastState(member.id)?.[1]).toBe("failed");
    expect(lastState(member.id)?.[2]).toMatchObject({ errorMessage: "Coupling address 192.168.100.253 is already in use on its network", groupStage: "failed" });
  });

  test("does not count a member admitted for an attempt the group has left", async () => {
    const member = { ...makeInstallation("stale-member"), group: { ...group(["admitted", "admitted"], [1, 1]), generation: 2 } };
    const ops = createMockOps({ checkHealth: mock(() => Promise.resolve(true)) });
    await firstValueFrom(syncVllmInstallations$([member], ops));
    expect(ops.start).not.toHaveBeenCalled();
    expect(lastState(member.id)?.[2]).toMatchObject({ groupStage: "admitted", groupGeneration: 2 });
  });

  test("starts a member with its group once every member is admitted or already running, and counts a headless rank up while it runs", async () => {
    const member = { ...makeInstallation("ready-member"), group: group(["running", "admitted"]) };
    const ops = createMockOps({ checkHealth: mock(() => Promise.resolve(false)), isAlive: mock(() => Promise.resolve(true)) });
    await firstValueFrom(syncVllmInstallations$([member], ops));
    const [, config] = (ops.start as ReturnType<typeof mock>).mock.calls[0]!;
    expect(config.group).toEqual({
      kind: "member", size: 2, rank: 1, masterAddr: "192.168.100.254", masterPort: 29500,
      paths: [{ subnet: "192.168.100.0/24", address: "192.168.100.253", interface: "enp1s0f0np0", rdmaDevice: "rocep1s0f0" }],
    });
    expect(config.kvCacheBytes).toBe("2g");
    expect(lastState(member.id)?.[1]).toBe("ready");
    expect(lastState(member.id)?.[2]?.groupStage).toBe("running");
  });

  test("stops a running member once its group moved on to the next attempt, and starts it for that attempt", async () => {
    const member = { ...makeInstallation("restarted-member"), group: { ...group(["admitted", "admitted"], [2, 2]), generation: 2 } };
    mockLocalStates.set(member.id, { lifecycleState: "ready", groupGeneration: 1 });
    const ops = createMockOps({ listRunning: mock(() => Promise.resolve([member.id])), isAlive: mock(() => Promise.resolve(true)) });
    await firstValueFrom(syncVllmInstallations$([member], ops));
    expect(ops.stop).toHaveBeenCalledWith(member.id);
    expect(ops.start).toHaveBeenCalled();
    expect(lastState(member.id)?.[2]).toMatchObject({ groupStage: "running", groupGeneration: 2 });
  });

  test("stops a running member whose group failed its current attempt, and fails it with the group", async () => {
    const member = { ...makeInstallation("abandoned-member"), group: group(["failed", "running"]) };
    mockLocalStates.set(member.id, { lifecycleState: "ready", groupGeneration: 1 });
    const ops = createMockOps({ listRunning: mock(() => Promise.resolve([member.id])) });
    await firstValueFrom(syncVllmInstallations$([member], ops));
    expect(ops.stop).toHaveBeenCalledWith(member.id);
    expect(ops.start).not.toHaveBeenCalled();
    expect(lastState(member.id)).toEqual([member.id, "failed", {
      errorMessage: "Stopped, another machine of its group failed",
      statusMessage: "Stopped, another machine of its group failed",
      groupStage: "failed",
      groupGeneration: 1,
    }]);
  });

  test("fails a member that exited while its group counts it running, naming the host memory budget, rather than launching it alone", async () => {
    const member = { ...makeInstallation("exited-member"), group: group(["running", "running"]) };
    mockLocalStates.set(member.id, { lifecycleState: "ready", groupGeneration: 1 });
    const ops = createMockOps({ wasOomKilled: mock(() => Promise.resolve(true)) });
    await firstValueFrom(syncVllmInstallations$([member], ops));
    expect(ops.start).not.toHaveBeenCalled();
    expect(ops.stop).toHaveBeenCalledWith(member.id);
    expect(lastState(member.id)?.[1]).toBe("failed");
    expect(lastState(member.id)?.[2]).toMatchObject({ errorMessage: "Stopped, over its host memory budget", groupStage: "failed", groupGeneration: 1 });
  });

  test("tries a failed member again once its group moved on to the next attempt, but not before", async () => {
    const failedMember = (generation: number) => ({ ...makeInstallation("failed-member"), group: { ...group(["admitted", "admitted"], [generation, generation]), generation } });
    const stillFailed = failedMember(1);
    mockLocalStates.set(stillFailed.id, { lifecycleState: "failed", groupGeneration: 1 });
    const retried = failedMember(2);
    mockLocalStates.set(retried.id, { lifecycleState: "failed", groupGeneration: 1 });
    const ops = createMockOps({ checkHealth: mock(() => Promise.resolve(false)), isAlive: mock(() => Promise.resolve(true)) });
    await firstValueFrom(syncVllmInstallations$([stillFailed, retried], ops));
    expect((ops.start as ReturnType<typeof mock>).mock.calls.map(([id]) => id)).toEqual([retried.id]);
  });
});

describe("enforcing the charge", () => {
  const sizing = { weightGb: 12, minKvCacheGb: 4, maxContextLength: 8192 };
  const startConfig = (ops: VllmOps) => (ops.start as ReturnType<typeof mock>).mock.calls[0]![1];
  const starting = () => createMockOps({ checkHealth: mock(() => Promise.resolve(true)) });

  beforeEach(() => {
    stateWrites.length = 0;
    mockLocalStates.clear();
  });

  test("opens the window the row is charged and limits host memory to its host part plus margin", async () => {
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { sizing })));
    const ops = starting();
    await firstValueFrom(syncVllmInstallations$([{ ...makeInstallation("charged-model"), estCapacity: 18, hostCapacity: 2 }], ops));
    expect(startConfig(ops).gpuMemoryUtilization).toBeCloseTo(18 / (24 * 1.073741824), 4);
    expect(startConfig(ops).hostMemoryLimitBytes).toBe(2.2e9);
  });

  test("gives the limit room for loading the largest file on disk", async () => {
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { sizing })));
    largestWeightFileSpy.mockResolvedValueOnce(4e8);
    const ops = starting();
    await firstValueFrom(syncVllmInstallations$([{ ...makeInstallation("sharded-model"), estCapacity: 18, hostCapacity: 2 }], ops));
    expect(startConfig(ops).hostMemoryLimitBytes).toBe(3.2e9);
  });

  test("reserves for loading only what the catalog charges, as the scheduler does, however large a file on disk", async () => {
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { sizing })));
    largestWeightFileSpy.mockResolvedValueOnce(1e12);
    const placed = starting();
    await firstValueFrom(syncVllmInstallations$([{ ...makeInstallation("host-table-model"), hostCapacity: 2 }], placed));
    expect(placed.start).toHaveBeenCalled();
    expect(startConfig(placed).hostMemoryLimitBytes).toBeGreaterThan(2.5e12);

    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { sizing: { ...sizing, largestFileGb: 1000 } })));
    const tooBig = starting();
    await firstValueFrom(syncVllmInstallations$([{ ...makeInstallation("huge-shard-model"), hostCapacity: 2 }], tooBig));
    expect(tooBig.start).not.toHaveBeenCalled();
  });

  test("runs as many sequences at once as the row says", async () => {
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { sizing })));
    const ops = starting();
    await firstValueFrom(syncVllmInstallations$([{ ...makeInstallation("capped-model"), hostCapacity: 2, maxNumSeqs: 48 }], ops));
    const args = startConfig(ops).extraArgs as string[];
    expect(args.slice(args.indexOf("--max-num-seqs"), args.indexOf("--max-num-seqs") + 2)).toEqual(["--max-num-seqs", "48"]);
  });

  test("never limits host memory below 1 GiB", async () => {
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { sizing })));
    const ops = starting();
    await firstValueFrom(syncVllmInstallations$([{ ...makeInstallation("tiny-model"), hostCapacity: 0.1 }], ops));
    expect(startConfig(ops).hostMemoryLimitBytes).toBe(2 ** 30);
  });

  test("falls back to the fitted window and no limit for a row the scheduler has not charged, or one of the deprecated format", async () => {
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { sizing })));
    const uncharged = starting();
    await firstValueFrom(syncVllmInstallations$([makeInstallation("uncharged-model")], uncharged));
    expect(startConfig(uncharged).hostMemoryLimitBytes).toBeUndefined();
    expect(startConfig(uncharged).gpuMemoryUtilization).toBeCloseTo(computeGpuUtilization(
      { specifier: "uncharged-model", gpuGb: fittedGpuGb(12, 4) },
      { gpus: [nvidiaCard(24576)], gpuCount: 1, systemRamMb: 131072, detectedCapacityGb: 24, physicalCapacityGb: 24 },
    )!, 4);

    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier)));
    const legacy = starting();
    await firstValueFrom(syncVllmInstallations$([{ ...makeInstallation("legacy-model"), hostCapacity: 0 }], legacy));
    expect(startConfig(legacy).hostMemoryLimitBytes).toBeUndefined();
  });

  test("waits with the installation still installing while the node does not have its memory free", async () => {
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { sizing })));
    const ops = starting();
    await firstValueFrom(syncVllmInstallations$([{ ...makeInstallation("huge-model"), hostCapacity: 1e9 }], ops));
    expect(ops.start).not.toHaveBeenCalled();
    expect(stateWrites.some(([, state]) => state === "failed")).toBe(false);
    const [, state, update] = stateWrites.at(-1)!;
    expect(state).toBe("installing");
    expect(update?.statusMessage).toStartWith("Waiting for memory: needs 1000000000.0 GB");
  });

  test("retries a waiting start on the next sync without downloading again", async () => {
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { sizing })));
    mockResolveEntry.mockImplementationOnce((specifier) => Promise.resolve(catalogEntry(specifier, { sizing: { ...sizing, largestFileGb: 1000 } })));
    const installation = { ...makeInstallation("queued-model"), hostCapacity: 2 };
    downloadModelSpy.mockClear();
    const waiting = starting();
    await firstValueFrom(syncVllmInstallations$([installation], waiting));
    expect(waiting.start).not.toHaveBeenCalled();

    const ops = starting();
    await firstValueFrom(syncVllmInstallations$([installation], ops));
    expect(ops.start).toHaveBeenCalled();
    expect(downloadModelSpy).toHaveBeenCalledTimes(1);
  });

  test("fails a start that cannot fit next to the installations already running on the node", async () => {
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve(catalogEntry(specifier, { sizing })));
    mockHostMemoryGb = 100;
    const neighbour = { ...makeInstallation("neighbour-model"), hostCapacity: 90 };
    mockLocalStates.set(neighbour.id, { lifecycleState: "ready" });
    const ops = createMockOps({ listRunning: mock(() => Promise.resolve([neighbour.id])) });
    try {
      await firstValueFrom(syncVllmInstallations$([neighbour, { ...makeInstallation("crowded-model"), hostCapacity: 20 }], ops));
    } finally {
      mockHostMemoryGb = undefined;
    }
    expect(ops.start).not.toHaveBeenCalled();
    expect(stateWrites.find(([, state]) => state === "failed")?.[2]?.errorMessage).toBe(
      "Does not fit next to the installations running here: needs 20.0 GB, at most 10.0 GB can be free",
    );
  });

  test("names going over the host memory budget as the reason an installation stopped", async () => {
    const id = crypto.randomUUID();
    const ops = createMockOps({
      listRunning: mock(() => Promise.resolve([id])),
      isAlive: mock(() => Promise.resolve(false)),
      wasOomKilled: mock(() => Promise.resolve(true)),
    });
    mockLocalStates.set(id, { lifecycleState: "installing" });
    await firstValueFrom(syncVllmInstallations$([makeInstallation("oom-model", id)], ops));
    const failedWrite = stateWrites.find(([, state]) => state === "failed");
    expect(failedWrite![2]?.errorMessage).toBe("Stopped, over its host memory budget");
  });

  test("warns from 90% of the limit, and not without one", () => {
    expect(hostUseMessage({ usedBytes: 9.1e9, limitBytes: 10e9 })).toBe("Using 9.1 of its 10.0 GB host memory budget");
    expect(hostUseMessage({ usedBytes: 8.9e9, limitBytes: 10e9 })).toBeUndefined();
    expect(hostUseMessage({ usedBytes: 9.1e9 })).toBeUndefined();
  });

  test("reports a running installation close to its budget, and clears the warning once it is not", async () => {
    const id = crypto.randomUUID();
    const near = createMockOps({
      listRunning: mock(() => Promise.resolve([id])),
      memoryUse: mock(() => Promise.resolve({ usedBytes: 9.5e9, limitBytes: 10e9 })),
    });
    mockLocalStates.set(id, { lifecycleState: "ready" });
    await firstValueFrom(syncVllmInstallations$([makeInstallation("busy-model", id)], near));
    expect(stateWrites.find(([, state]) => state === "ready")?.[2]?.statusMessage).toBe("Using 9.5 of its 10.0 GB host memory budget");

    stateWrites.length = 0;
    mockLocalStates.set(id, { lifecycleState: "ready", statusMessage: "Using 9.5 of its 10.0 GB host memory budget" });
    const calm = createMockOps({
      listRunning: mock(() => Promise.resolve([id])),
      memoryUse: mock(() => Promise.resolve({ usedBytes: 5e9, limitBytes: 10e9 })),
    });
    await firstValueFrom(syncVllmInstallations$([makeInstallation("busy-model", id)], calm));
    expect(stateWrites.find(([, state]) => state === "ready")?.[2]?.statusMessage).toBe("vLLM server healthy");
  });
});
