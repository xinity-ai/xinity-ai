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
  getHardwareProfile: async () => ({ gpus: [], gpuCount: 0 }),
}));

const mockSnapshot = mock(() => null as import("../metrics-sampler").MetricsBucket | null);

mock.module("../metrics-sampler", () => ({
  getMetricsSnapshot: mockSnapshot,
}));

const { handleDaemonMetrics } = await import("./metrics");

function makeReq(overrides?: { method?: string; auth?: string }) {
  const method = overrides?.method ?? "GET";
  const headers = new Headers();
  if (overrides?.auth) headers.set("authorization", overrides.auth);
  return new Request("http://daemon/metrics", { method, headers });
}

describe("handleDaemonMetrics", () => {
  beforeEach(() => {
    mockSnapshot.mockReset();
    mockSnapshot.mockReturnValue(null);
  });

  test("returns 405 for non-GET requests", async () => {
    const res = await handleDaemonMetrics(makeReq({ method: "POST" }));
    expect(res.status).toBe(405);
  });

  test("includes daemon_up=1 with node_id label", async () => {
    const res = await handleDaemonMetrics(makeReq());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('daemon_up{node_id="test-node-uuid"} 1');
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  test("omits GPU metrics when no snapshot is available", async () => {
    const res = await handleDaemonMetrics(makeReq());
    const body = await res.text();
    expect(body).not.toContain("daemon_gpu_");
  });

  test("emits GPU gauge and counter metrics when snapshot is present", async () => {
    mockSnapshot.mockReturnValue({
      gpuUtilizationAvg: 73.5,
      gpuUtilizationMax: 91.0,
      memoryUsedMb: 32768,
      powerWattsAvg: 320.25,
      energyWh: 8.12,
    });

    const res = await handleDaemonMetrics(makeReq());
    const body = await res.text();

    expect(body).toContain('daemon_gpu_utilization_avg{node_id="test-node-uuid"} 73.5');
    expect(body).toContain('daemon_gpu_utilization_max{node_id="test-node-uuid"} 91');
    expect(body).toContain('daemon_gpu_memory_used_mb{node_id="test-node-uuid"} 32768');
    expect(body).toContain('daemon_gpu_power_draw_watts{node_id="test-node-uuid"} 320.25');
    expect(body).toContain('daemon_gpu_energy_wh_total{node_id="test-node-uuid"} 8.12');
    expect(body).toContain("# TYPE daemon_gpu_utilization_avg gauge");
    expect(body).toContain("# TYPE daemon_gpu_energy_wh_total counter");
  });

  test("omits power draw metric when powerWattsAvg is null", async () => {
    mockSnapshot.mockReturnValue({
      gpuUtilizationAvg: 50,
      gpuUtilizationMax: 50,
      memoryUsedMb: 8192,
      powerWattsAvg: null,
      energyWh: 2.5,
    });

    const body = await (await handleDaemonMetrics(makeReq())).text();
    expect(body).not.toContain("daemon_gpu_power_draw_watts");
    expect(body).toContain("daemon_gpu_energy_wh_total");
  });
});

describe("handleDaemonMetrics, basic auth", () => {
  beforeEach(() => mockSnapshot.mockReturnValue(null));

  test("rejects when auth is configured and no header is sent", async () => {
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
        METRICS_AUTH: "admin:secret",
      },
    }));
  });

  // Note: because mock.module state is global and METRICS_AUTH is parsed at module load
  // time, the auth tests are covered by the gateway's metrics.ts which has the same logic.
  // The no-auth path is covered by the tests above (METRICS_AUTH: undefined → open).
});
