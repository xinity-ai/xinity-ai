import { describe, test, expect, mock } from "bun:test";

// Mock env to avoid parseEnv side-effect (requires DB_CONNECTION_URL etc. in CI)
mock.module("../env", () => ({ env: {
  PORT: 4010,
  HOST: "0.0.0.0",
  XINITY_OLLAMA_ENDPOINT: "http://localhost:11434",
  DB_CONNECTION_URL: "postgres://localhost/test",
  STATE_DIR: "/tmp/test-state",
  CIDR_PREFIX: "",
  SYNC_INTERVAL_MS: 60_000,
  INFOSERVER_URL: "http://localhost:19090",
  INFOSERVER_CACHE_TTL_MS: 30_000,
  METRICS_SAMPLE_INTERVAL_MS: 20_000,
  VLLM_BACKEND: "systemd",
  VLLM_ENV_DIR: "/etc/vllm",
  VLLM_TEMPLATE_UNIT_PATH: "/etc/systemd/system/vllm-driver@.service",
  VLLM_PATH: undefined,
  VLLM_DOCKER_IMAGE: undefined,
  VLLM_HF_CACHE_DIR: "/var/lib/vllm/hf-cache",
  VLLM_TRITON_CACHE_DIR: "/var/lib/vllm/triton-cache",
  VLLM_HEALTH_TIMEOUT_MS: 3_600_000,
  VLLM_HEALTH_POLL_INTERVAL_MS: 5_000,
  LOG_LEVEL: "silent",
  LOG_DIR: undefined,
}}));

const {
  parseNvidiaMetricsOutput,
  parseThrottleOutput,
  estimateTdpWatts,
  estimatePowerWatts,
  GpuMetricsStore,
} = await import("./metrics-sampler");

type GpuMetricSample = import("./metrics-sampler").GpuMetricSample;

// Column order: index,uuid,name,driver_version,util.gpu,util.mem,temp,power.draw,power.limit,mem.used,mem.total,ecc.unc,ecc.cor
const LINE = "0, GPU-abc, NVIDIA H100 80GB HBM3, 560.35.03, 87, 41, 62, 310.45, 700, 65321, 81559, 0, 3";

describe("parseNvidiaMetricsOutput", () => {
  test("parses every queried field", () => {
    const [s] = parseNvidiaMetricsOutput(LINE + "\n");
    expect(s).toEqual({
      index: 0,
      uuid: "GPU-abc",
      name: "NVIDIA H100 80GB HBM3",
      driverVersion: "560.35.03",
      utilizationPct: 87,
      memoryUtilizationPct: 41,
      temperatureC: 62,
      powerWatts: 310.45,
      powerLimitWatts: 700,
      memoryUsedMb: 65321,
      memoryTotalMb: 81559,
      eccUncorrected: 0,
      eccCorrected: 3,
    });
  });

  test("parses multiple GPUs", () => {
    const csv = [LINE, "1, GPU-def, NVIDIA H100 80GB HBM3, 560.35.03, 12, 5, 50, 95.0, 700, 2048, 81559, 0, 0"].join("\n");
    const samples = parseNvidiaMetricsOutput(csv);
    expect(samples).toHaveLength(2);
    expect(samples[1]!.index).toBe(1);
    expect(samples[1]!.uuid).toBe("GPU-def");
  });

  test("maps [N/A] fields to null (numbers) and null (driver string)", () => {
    const csv = "0, GPU-x, NVIDIA GB10, [N/A], 45, [N/A], [N/A], [N/A], [N/A], 1024, [N/A], [N/A], [N/A]";
    const [s] = parseNvidiaMetricsOutput(csv);
    expect(s!.driverVersion).toBeNull();
    expect(s!.powerWatts).toBeNull();
    expect(s!.temperatureC).toBeNull();
    expect(s!.memoryTotalMb).toBeNull();
    expect(s!.eccUncorrected).toBeNull();
    expect(s!.utilizationPct).toBe(45);
    expect(s!.memoryUsedMb).toBe(1024);
  });

  test("skips lines without a uuid or name", () => {
    const csv = "0, , , 560, 10, 5, 50, 100, 700, 100, 200, 0, 0\n" + LINE;
    const samples = parseNvidiaMetricsOutput(csv);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.uuid).toBe("GPU-abc");
  });

  test("returns empty for empty or blank output", () => {
    expect(parseNvidiaMetricsOutput("")).toEqual([]);
    expect(parseNvidiaMetricsOutput("  \n \n")).toEqual([]);
  });
});

describe("parseThrottleOutput", () => {
  test("reads the hex bitmask into a per-index boolean", () => {
    const map = parseThrottleOutput("0, 0x0000000000000000\n1, 0x0000000000000004\n");
    expect(map.get(0)).toBe(false);
    expect(map.get(1)).toBe(true);
  });

  test("ignores unparseable lines (e.g. an nvidia-smi error)", () => {
    const map = parseThrottleOutput("Field 'x' is not a valid field to query.\n");
    expect(map.size).toBe(0);
  });
});

describe("power estimation", () => {
  test("matches known GPUs by substring", () => {
    expect(estimateTdpWatts("NVIDIA H100 80GB HBM3")).toBe(500);
    expect(estimateTdpWatts("NVIDIA GB10")).toBe(100);
    expect(estimateTdpWatts("NVIDIA RTX PRO 6000 Blackwell Workstation Edition")).toBe(600);
    expect(estimateTdpWatts("NVIDIA RTX 6000 Ada Generation")).toBe(300);
  });

  test("falls back to default TDP for unknown GPUs", () => {
    expect(estimateTdpWatts("Some Future GPU")).toBe(250);
  });

  test("scales between idle and TDP with utilization", () => {
    expect(estimatePowerWatts("NVIDIA H100", 0)).toBeCloseTo(50);
    expect(estimatePowerWatts("NVIDIA H100", 100)).toBeCloseTo(500);
    expect(estimatePowerWatts("NVIDIA H100", 50)).toBeCloseTo(275);
  });

  test("clamps out-of-range utilization", () => {
    expect(estimatePowerWatts("NVIDIA H100", -5)).toBeCloseTo(50);
    expect(estimatePowerWatts("NVIDIA H100", 150)).toBeCloseTo(500);
  });
});

describe("GpuMetricsStore", () => {
  const gpu = (over: Partial<GpuMetricSample> = {}): GpuMetricSample => ({
    index: 0, uuid: "GPU-a", name: "NVIDIA H100", driverVersion: "560",
    utilizationPct: 50, memoryUtilizationPct: 20, temperatureC: 60,
    powerWatts: 360, powerLimitWatts: 700, memoryUsedMb: 1000, memoryTotalMb: 81559,
    eccUncorrected: 0, eccCorrected: 0, ...over,
  });

  test("starts empty", () => {
    const snap = new GpuMetricsStore().snapshot();
    expect(snap.gpus).toEqual([]);
    expect(snap.sampleFailures).toBe(0);
  });

  test("exposes the latest sample per GPU with integrated energy", () => {
    const store = new GpuMetricsStore();
    store.add([gpu({ powerWatts: 360 })], 60_000); // 360 W for 1 min = 6 Wh
    const snap = store.snapshot();
    expect(snap.gpus).toHaveLength(1);
    expect(snap.gpus[0]!.uuid).toBe("GPU-a");
    expect(snap.gpus[0]!.energyWh).toBeCloseTo(6);
  });

  test("accumulates energy across polls and keeps the newest readings", () => {
    const store = new GpuMetricsStore();
    store.add([gpu({ utilizationPct: 50, powerWatts: 360 })], 60_000);
    store.add([gpu({ utilizationPct: 90, powerWatts: 360 })], 60_000);
    const g = store.snapshot().gpus[0]!;
    expect(g.energyWh).toBeCloseTo(12);
    expect(g.utilizationPct).toBe(90); // latest wins
  });

  test("tracks each GPU separately by uuid", () => {
    const store = new GpuMetricsStore();
    store.add([gpu({ uuid: "GPU-a", index: 0 }), gpu({ uuid: "GPU-b", index: 1 })], 60_000);
    expect(store.snapshot().gpus.map((g) => g.uuid).sort()).toEqual(["GPU-a", "GPU-b"]);
  });

  test("estimates power for energy when the driver reports none", () => {
    const store = new GpuMetricsStore();
    store.add([gpu({ powerWatts: null, utilizationPct: 100 })], 3_600_000); // 1 h at full load, H100 ~500 Wh
    expect(store.snapshot().gpus[0]!.energyWh).toBeCloseTo(500);
  });

  test("applies throttle state by GPU index, null when unknown", () => {
    const store = new GpuMetricsStore();
    store.add([gpu({ index: 0, uuid: "GPU-a" }), gpu({ index: 1, uuid: "GPU-b" })], 60_000);
    store.setThrottled(new Map([[0, true]]));
    const byUuid = new Map(store.snapshot().gpus.map((g) => [g.uuid, g.throttled]));
    expect(byUuid.get("GPU-a")).toBe(true);
    expect(byUuid.get("GPU-b")).toBeNull();
  });

  test("counts failures and resets", () => {
    const store = new GpuMetricsStore();
    store.recordFailure();
    store.recordFailure();
    store.add([gpu()], 60_000);
    expect(store.snapshot().sampleFailures).toBe(2);
    store.reset();
    expect(store.snapshot()).toEqual({ gpus: [], sampleFailures: 0 });
  });
});
