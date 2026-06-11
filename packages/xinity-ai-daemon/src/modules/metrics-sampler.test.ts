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
  estimateTdpWatts,
  estimatePowerWatts,
  MetricsAccumulator,
} = await import("./metrics-sampler");

describe("parseNvidiaMetricsOutput", () => {
  test("parses utilization, power, and memory", () => {
    const csv = "NVIDIA H100 PCIe, 87, 310.45, 65321\n";
    const samples = parseNvidiaMetricsOutput(csv);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.name).toBe("NVIDIA H100 PCIe");
    expect(samples[0]!.utilizationPct).toBe(87);
    expect(samples[0]!.powerWatts).toBeCloseTo(310.45);
    expect(samples[0]!.memoryUsedMb).toBe(65321);
  });

  test("parses multiple GPUs", () => {
    const csv = [
      "NVIDIA RTX PRO 6000 Blackwell, 71, 412.10, 49000",
      "NVIDIA RTX PRO 6000 Blackwell, 12, 95.00, 2048",
    ].join("\n");
    const samples = parseNvidiaMetricsOutput(csv);
    expect(samples).toHaveLength(2);
    expect(samples[1]!.utilizationPct).toBe(12);
  });

  test("maps [N/A] power to null and N/A fields to 0", () => {
    const csv = "NVIDIA GB10, 45, [N/A], N/A\n";
    const samples = parseNvidiaMetricsOutput(csv);
    expect(samples[0]!.powerWatts).toBeNull();
    expect(samples[0]!.utilizationPct).toBe(45);
    expect(samples[0]!.memoryUsedMb).toBe(0);
  });

  test("returns empty array for empty or blank output", () => {
    expect(parseNvidiaMetricsOutput("")).toEqual([]);
    expect(parseNvidiaMetricsOutput("  \n \n")).toEqual([]);
  });

  test("skips lines without a name", () => {
    const csv = ", 10, 50, 100\nNVIDIA T4, 5, 30, 200\n";
    const samples = parseNvidiaMetricsOutput(csv);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.name).toBe("NVIDIA T4");
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
    expect(estimatePowerWatts("NVIDIA H100", 0)).toBeCloseTo(50); // 10% idle floor
    expect(estimatePowerWatts("NVIDIA H100", 100)).toBeCloseTo(500);
    expect(estimatePowerWatts("NVIDIA H100", 50)).toBeCloseTo(275);
  });

  test("clamps out-of-range utilization", () => {
    expect(estimatePowerWatts("NVIDIA H100", -5)).toBeCloseTo(50);
    expect(estimatePowerWatts("NVIDIA H100", 150)).toBeCloseTo(500);
  });
});

describe("MetricsAccumulator", () => {
  const gpu = (utilizationPct: number, powerWatts: number | null, memoryUsedMb = 1000) => ({
    name: "NVIDIA H100",
    utilizationPct,
    powerWatts,
    memoryUsedMb,
  });

  test("snapshot is null without samples", () => {
    expect(new MetricsAccumulator().snapshot()).toBeNull();
  });

  test("averages utilization across GPUs and samples, tracks per-GPU max", () => {
    const acc = new MetricsAccumulator();
    acc.add([gpu(20, 100), gpu(40, 100)], 20_000); // node avg 30
    acc.add([gpu(60, 100), gpu(90, 100)], 20_000); // node avg 75
    const bucket = acc.snapshot()!;
    expect(bucket.gpuUtilizationAvg).toBeCloseTo(52.5);
    expect(bucket.gpuUtilizationMax).toBe(90);
  });

  test("sums memory and power across GPUs, averages across samples", () => {
    const acc = new MetricsAccumulator();
    acc.add([gpu(50, 200, 30_000), gpu(50, 300, 10_000)], 20_000);
    acc.add([gpu(50, 100, 20_000), gpu(50, 100, 20_000)], 20_000);
    const bucket = acc.snapshot()!;
    expect(bucket.memoryUsedMb).toBe(40_000);
    expect(bucket.powerWattsAvg).toBeCloseTo(350);
  });

  test("integrates energy over sample durations", () => {
    const acc = new MetricsAccumulator();
    // 360 W for 1 minute = 6 Wh, twice = 12 Wh
    acc.add([gpu(50, 360)], 60_000);
    acc.add([gpu(50, 360)], 60_000);
    expect(acc.snapshot()!.energyWh).toBeCloseTo(12);
  });

  test("estimates power from utilization when not measured", () => {
    const acc = new MetricsAccumulator();
    acc.add([gpu(100, null)], 3_600_000); // 1 h at full load on an H100 → ~500 Wh
    const bucket = acc.snapshot()!;
    expect(bucket.powerWattsAvg).toBeCloseTo(500);
    expect(bucket.energyWh).toBeCloseTo(500);
  });

  test("reset clears accumulated state", () => {
    const acc = new MetricsAccumulator();
    acc.add([gpu(50, 100)], 20_000);
    acc.reset();
    expect(acc.snapshot()).toBeNull();
  });

  test("ignores polls that returned no GPUs", () => {
    const acc = new MetricsAccumulator();
    acc.add([], 20_000);
    expect(acc.snapshot()).toBeNull();
  });
});
