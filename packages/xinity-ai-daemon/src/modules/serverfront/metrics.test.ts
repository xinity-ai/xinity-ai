import { describe, test, expect, mock, beforeEach } from "bun:test";

mock.module("../../env", () => ({
  env: {
    PORT: 4044, HOST: "0.0.0.0", DB_CONNECTION_URL: "postgres://localhost/test",
    STATE_DIR: "/tmp/test", CIDR_PREFIX: "", SYNC_INTERVAL_MS: 60_000,
    INFOSERVER_URL: "http://localhost:19090", INFOSERVER_CACHE_TTL_MS: 30_000,
    METRICS_SAMPLE_INTERVAL_MS: 20_000, VLLM_BACKEND: "systemd",
    VLLM_ENV_DIR: "/etc/vllm", VLLM_TEMPLATE_UNIT_PATH: "/etc/systemd/system/vllm-driver@.service",
    VLLM_HF_CACHE_DIR: "/var/lib/vllm/hf-cache", VLLM_TRITON_CACHE_DIR: "/var/lib/vllm/triton-cache",
    VLLM_HEALTH_TIMEOUT_MS: 3_600_000, VLLM_HEALTH_POLL_INTERVAL_MS: 5_000,
    LOG_LEVEL: "silent", LOG_DIR: undefined,
    METRICS_AUTH: undefined,
  },
}));

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
  });

  test("returns 405 for non-GET requests", async () => {
    expect((await handleDaemonMetrics(makeReq({ method: "POST" }))).status).toBe(405);
  });

  test("always emits daemon_up with the node_id label", async () => {
    const res = await handleDaemonMetrics(makeReq());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('daemon_up{node_id="test-node-uuid",machine_name="test-machine"} 1');
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  test("omits all GPU metrics when the sampler has not started", async () => {
    const body = await (await handleDaemonMetrics(makeReq())).text();
    expect(body).not.toContain("daemon_gpu_");
  });

  test("emits per-GPU series labeled by gpu index and uuid", async () => {
    mockSnapshot.mockReturnValue(snapshot([gpu()]));
    const body = await (await handleDaemonMetrics(makeReq())).text();

    const labels = 'node_id="test-node-uuid",machine_name="test-machine",gpu="0",uuid="GPU-aaaa"';
    expect(body).toContain(`daemon_gpu_utilization_percent{${labels}} 73.5`);
    expect(body).toContain(`daemon_gpu_memory_utilization_percent{${labels}} 41`);
    expect(body).toContain(`daemon_gpu_memory_used_mb{${labels}} 32768`);
    expect(body).toContain(`daemon_gpu_memory_total_mb{${labels}} 81559`);
    expect(body).toContain(`daemon_gpu_temperature_celsius{${labels}} 62`);
    expect(body).toContain(`daemon_gpu_power_draw_watts{${labels}} 320.25`);
    expect(body).toContain(`daemon_gpu_power_limit_watts{${labels}} 700`);
    expect(body).toContain(`daemon_gpu_throttled{${labels}} 0`);
    expect(body).toContain(`daemon_gpu_energy_wh_total{${labels}} 8.12`);
    expect(body).toContain(`daemon_gpu_info{${labels},name="NVIDIA H100 80GB HBM3",driver_version="560.35.03"} 1`);
    expect(body).toContain(`daemon_gpu_ecc_errors_total{${labels},type="uncorrected"} 0`);
    expect(body).toContain(`daemon_gpu_ecc_errors_total{${labels},type="corrected"} 2`);
    expect(body).toContain('daemon_gpu_sample_failures_total{node_id="test-node-uuid",machine_name="test-machine"} 0');
  });

  test("emits one HELP/TYPE header per family across multiple GPUs", async () => {
    mockSnapshot.mockReturnValue(snapshot([gpu({ index: 0, uuid: "GPU-a" }), gpu({ index: 1, uuid: "GPU-b" })]));
    const body = await (await handleDaemonMetrics(makeReq())).text();

    expect(body.match(/# TYPE daemon_gpu_utilization_percent gauge/g)).toHaveLength(1);
    expect(body).toContain('gpu="0",uuid="GPU-a"');
    expect(body).toContain('gpu="1",uuid="GPU-b"');
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
    expect(body).toContain('daemon_gpu_sample_failures_total{node_id="test-node-uuid",machine_name="test-machine"} 4');
  });
});
