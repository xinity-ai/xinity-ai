import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mockDaemonConfig } from "../../mock-config";

mock.module("../../config", () => ({ config: mockDaemonConfig() }));

mock.module("../statekeeper", () => ({
  getNodeId: async () => "test-node-uuid",
  getMachineName: () => "test-machine",
  getHardwareProfile: async () => ({ gpus: [], gpuCount: 0 }),
}));

type Snapshot = import("../metrics-sampler").MetricsSnapshot;
type GpuSnapshot = import("../metrics-sampler").GpuSnapshot;

const mockSnapshot = mock(() => null as Snapshot | null);

mock.module("../metrics-sampler", () => ({
  getMetricsSnapshot: mockSnapshot,
}));

const { handleDaemonMetrics } = await import("./metrics");
const { updateRegistry } = await import("../model-registry");

function gpu(over: Partial<GpuSnapshot> = {}): GpuSnapshot {
  return {
    index: 0,
    uuid: "GPU-aaaa",
    name: "NVIDIA H100 80GB HBM3",
    driverVersion: "560.35.03",
    utilizationPct: 73.5,
    memoryUtilizationPct: 41,
    temperatureC: 62,
    powerWatts: 320.25,
    powerLimitWatts: 700,
    memoryUsedMb: 32768,
    memoryTotalMb: 81559,
    eccUncorrected: 0,
    eccCorrected: 2,
    energyWh: 8.12,
    throttled: false,
    ...over,
  };
}

function snapshot(gpus: GpuSnapshot[], sampleFailures = 0): Snapshot {
  return { gpus, sampleFailures };
}

function makeReq(overrides?: { method?: string; auth?: string }) {
  const headers = new Headers();
  if (overrides?.auth) headers.set("authorization", overrides.auth);
  return new Request("http://daemon/metrics", { method: overrides?.method ?? "GET", headers });
}

describe("handleDaemonMetrics", () => {
  beforeEach(() => {
    mockSnapshot.mockReset();
    mockSnapshot.mockReturnValue(null);
    updateRegistry([]);
  });

  test("returns 405 for non-GET requests", async () => {
    expect((await handleDaemonMetrics(makeReq({ method: "POST" }))).status).toBe(405);
  });

  test("always emits daemon_up with the node_id label", async () => {
    const res = await handleDaemonMetrics(makeReq());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('daemon_up{machine_name="test-machine",node_id="test-node-uuid"} 1');
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  test("omits all GPU metrics when the sampler has not started", async () => {
    const body = await (await handleDaemonMetrics(makeReq())).text();
    expect(body).not.toContain("daemon_gpu_");
  });

  test("emits per-GPU series labeled by gpu index and uuid", async () => {
    mockSnapshot.mockReturnValue(snapshot([gpu()]));
    const body = await (await handleDaemonMetrics(makeReq())).text();

    const labels = 'gpu="0",machine_name="test-machine",node_id="test-node-uuid",uuid="GPU-aaaa"';
    expect(body).toContain(`daemon_gpu_utilization_percent{${labels}} 73.5`);
    expect(body).toContain(`daemon_gpu_memory_utilization_percent{${labels}} 41`);
    expect(body).toContain(`daemon_gpu_memory_used_mb{${labels}} 32768`);
    expect(body).toContain(`daemon_gpu_memory_total_mb{${labels}} 81559`);
    expect(body).toContain(`daemon_gpu_temperature_celsius{${labels}} 62`);
    expect(body).toContain(`daemon_gpu_power_draw_watts{${labels}} 320.25`);
    expect(body).toContain(`daemon_gpu_power_limit_watts{${labels}} 700`);
    expect(body).toContain(`daemon_gpu_throttled{${labels}} 0`);
    expect(body).toContain(`daemon_gpu_energy_wh_total{${labels}} 8.12`);
    expect(body).toContain(
      'daemon_gpu_info{driver_version="560.35.03",gpu="0",machine_name="test-machine",name="NVIDIA H100 80GB HBM3",node_id="test-node-uuid",uuid="GPU-aaaa"} 1',
    );
    expect(body).toContain(
      'daemon_gpu_ecc_errors_total{gpu="0",machine_name="test-machine",node_id="test-node-uuid",type="uncorrected",uuid="GPU-aaaa"} 0',
    );
    expect(body).toContain(
      'daemon_gpu_ecc_errors_total{gpu="0",machine_name="test-machine",node_id="test-node-uuid",type="corrected",uuid="GPU-aaaa"} 2',
    );
    expect(body).toContain('daemon_gpu_sample_failures_total{machine_name="test-machine",node_id="test-node-uuid"} 0');
  });

  test("emits one HELP/TYPE header per family across multiple GPUs", async () => {
    mockSnapshot.mockReturnValue(snapshot([gpu({ index: 0, uuid: "GPU-a" }), gpu({ index: 1, uuid: "GPU-b" })]));
    const body = await (await handleDaemonMetrics(makeReq())).text();

    expect(body.match(/# TYPE daemon_gpu_utilization_percent gauge/g)).toHaveLength(1);
    expect(body).toContain('gpu="0",machine_name="test-machine",node_id="test-node-uuid",uuid="GPU-a"');
    expect(body).toContain('gpu="1",machine_name="test-machine",node_id="test-node-uuid",uuid="GPU-b"');
    expect(body).toContain("# TYPE daemon_gpu_energy_wh_total counter");
  });

  test("skips fields the device does not report, but still counts energy", async () => {
    mockSnapshot.mockReturnValue(snapshot([gpu({
      powerWatts: null, powerLimitWatts: null, memoryTotalMb: null,
      temperatureC: null, memoryUtilizationPct: null, eccUncorrected: null,
      eccCorrected: null, throttled: null, energyWh: 2.5,
    })]));
    const body = await (await handleDaemonMetrics(makeReq())).text();

    expect(body).not.toContain("daemon_gpu_power_draw_watts");
    expect(body).not.toContain("daemon_gpu_power_limit_watts");
    expect(body).not.toContain("daemon_gpu_memory_total_mb");
    expect(body).not.toContain("daemon_gpu_temperature_celsius");
    expect(body).not.toContain("daemon_gpu_throttled");
    expect(body).not.toContain("daemon_gpu_ecc_errors_total");
    expect(body).toContain("daemon_gpu_energy_wh_total");
    expect(body).toContain("daemon_gpu_utilization_percent");
  });

  test("reports the sample-failure count", async () => {
    mockSnapshot.mockReturnValue(snapshot([], 4));
    const body = await (await handleDaemonMetrics(makeReq())).text();
    expect(body).toContain('daemon_gpu_sample_failures_total{machine_name="test-machine",node_id="test-node-uuid"} 4');
  });
});

const VLLM_EXPOSITION = [
  "# HELP vllm:prefix_cache_hits_total Prefix cache block hits.",
  "# TYPE vllm:prefix_cache_hits_total counter",
  'vllm:prefix_cache_hits_total{model_name="qwen3"} 128',
  "",
].join("\n");

describe("engine metrics", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockSnapshot.mockReset();
    mockSnapshot.mockReturnValue(null);
    updateRegistry([]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("appends the engine exposition unmodified", async () => {
    updateRegistry([{ specifier: "qwen3", port: 8001, driver: "vllm" }]);
    const fetchMock = mock(async () => new Response(VLLM_EXPOSITION));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const body = await (await handleDaemonMetrics(makeReq())).text();

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8001/metrics", expect.anything());
    expect(body).toContain(VLLM_EXPOSITION);
    expect(body).toContain("daemon_up");
  });

  test("drops the engine's python and http collectors, which collide with the daemon's own", async () => {
    updateRegistry([{ specifier: "qwen3", port: 8001, driver: "vllm" }]);
    globalThis.fetch = mock(async () => new Response([
      "# HELP process_resident_memory_bytes Resident memory size in bytes.",
      "# TYPE process_resident_memory_bytes gauge",
      "process_resident_memory_bytes 1.098084352e+09",
      "# HELP python_info Python platform information",
      "# TYPE python_info gauge",
      'python_info{version="3.12.7"} 1.0',
      "# HELP http_requests_total Total HTTP requests.",
      "# TYPE http_requests_total counter",
      'http_requests_total{handler="/v1/chat/completions",method="POST",status="2xx"} 1.0',
      VLLM_EXPOSITION,
    ].join("\n"))) as unknown as typeof fetch;

    const body = await (await handleDaemonMetrics(makeReq())).text();

    expect(body).toContain('vllm:prefix_cache_hits_total{model_name="qwen3"} 128');
    expect(body).not.toContain("1.098084352e+09");
    expect(body).not.toContain("python_info");
    expect(body).not.toContain('handler="/v1/chat/completions"');
    expect(body.match(/^process_resident_memory_bytes /gm)).toHaveLength(1);
  });

  test("keeps the reachable engine when another one fails", async () => {
    updateRegistry([
      { specifier: "hung", port: 8001, driver: "vllm" },
      { specifier: "qwen3", port: 8002, driver: "vllm" },
    ]);
    globalThis.fetch = mock(async (input: string) => {
      if (input.includes("8001")) {
        throw new Error("The operation timed out.");
      }
      return new Response(VLLM_EXPOSITION);
    }) as unknown as typeof fetch;

    const body = await (await handleDaemonMetrics(makeReq())).text();

    expect(body).toContain('vllm:prefix_cache_hits_total{model_name="qwen3"} 128');
    expect(body).toContain("daemon_up");
  });

  test("drops an engine that answers with an error status", async () => {
    updateRegistry([{ specifier: "qwen3", port: 8001, driver: "vllm" }]);
    globalThis.fetch = mock(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;

    const body = await (await handleDaemonMetrics(makeReq())).text();

    expect(body).not.toContain("nope");
    expect(body).toContain("daemon_up");
  });

  test("does not scrape an ollama installation", async () => {
    updateRegistry([{ specifier: "llama3.3", port: 8003, driver: "ollama" }]);
    const fetchMock = mock(async () => new Response(VLLM_EXPOSITION));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const body = await (await handleDaemonMetrics(makeReq())).text();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(body).not.toContain("vllm:");
  });
});
