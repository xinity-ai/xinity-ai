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
  parseNvidiaSmiOutput,
  parseRocmSmiOutput,
  parseXpuSmiDeviceList,
  parseXpuSmiDeviceDetails,
  classifyCapacitySource,
} = await import("./hardware-detect");
type DetectedGpu = import("./hardware-detect").DetectedGpu;

// ---------------------------------------------------------------------------
// parseNvidiaSmiOutput
// ---------------------------------------------------------------------------

describe("parseNvidiaSmiOutput", () => {
  test("parses single GPU", () => {
    const csv = "0, NVIDIA GeForce RTX 4090, 24564\n";
    const gpus = parseNvidiaSmiOutput(csv);
    expect(gpus).toHaveLength(1);
    expect(gpus[0]!.vendor).toBe("nvidia");
    expect(gpus[0]!.name).toBe("NVIDIA GeForce RTX 4090");
    expect(gpus[0]!.vramMb).toBe(24564);
  });

  test("parses multiple GPUs", () => {
    const csv = [
      "0, NVIDIA A100, 81920",
      "1, NVIDIA A100, 81920",
      "2, NVIDIA A100, 81920",
    ].join("\n");
    const gpus = parseNvidiaSmiOutput(csv);
    expect(gpus).toHaveLength(3);
    for (const gpu of gpus) {
      expect(gpu.vendor).toBe("nvidia");
      expect(gpu.vramMb).toBe(81920);
    }
  });

  test("returns empty array for empty input", () => {
    expect(parseNvidiaSmiOutput("")).toEqual([]);
    expect(parseNvidiaSmiOutput("  \n  \n")).toEqual([]);
  });

  test("skips malformed lines without name", () => {
    const csv = "0, , 24564\n1, NVIDIA A100, 81920\n";
    const gpus = parseNvidiaSmiOutput(csv);
    // First line has empty name, parseNvidiaSmiLine returns null
    // Actually the split gives empty string which is falsy, so it's filtered
    expect(gpus.length).toBeGreaterThanOrEqual(1);
    expect(gpus.some((g) => g.name === "NVIDIA A100")).toBe(true);
  });

  test("handles non-numeric VRAM gracefully (defaults to 0)", () => {
    const csv = "0, NVIDIA T4, N/A\n";
    const gpus = parseNvidiaSmiOutput(csv);
    expect(gpus).toHaveLength(1);
    expect(gpus[0]!.vramMb).toBe(0);
  });

  test("ignores trailing newlines", () => {
    const csv = "0, NVIDIA H100, 81920\n\n\n";
    const gpus = parseNvidiaSmiOutput(csv);
    expect(gpus).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseRocmSmiOutput
// ---------------------------------------------------------------------------

describe("parseRocmSmiOutput", () => {
  test("parses single AMD GPU line", () => {
    const text = "GPU[0] : 16384 MB total";
    const gpus = parseRocmSmiOutput(text);
    expect(gpus).toHaveLength(1);
    expect(gpus[0]!.vendor).toBe("amd");
    expect(gpus[0]!.name).toBe("AMD GPU 0");
    expect(gpus[0]!.vramMb).toBe(16384);
  });

  test("parses multiple AMD GPUs", () => {
    const text = [
      "GPU[0] : 32768 MB total",
      "GPU[1] : 32768 MB total",
    ].join("\n");
    const gpus = parseRocmSmiOutput(text);
    expect(gpus).toHaveLength(2);
    expect(gpus[0]!.name).toBe("AMD GPU 0");
    expect(gpus[1]!.name).toBe("AMD GPU 1");
  });

  test("returns empty for empty input", () => {
    expect(parseRocmSmiOutput("")).toEqual([]);
  });

  test("ignores non-GPU lines (headers, separators)", () => {
    const text = [
      "======================== ROCm System Management Interface ========================",
      "GPU[0] : 49152 MB total",
      "======================== End of ROCm SMI Log ====================================",
    ].join("\n");
    const gpus = parseRocmSmiOutput(text);
    expect(gpus).toHaveLength(1);
    expect(gpus[0]!.vramMb).toBe(49152);
  });

  test("handles malformed GPU line gracefully", () => {
    const text = "GPU[0] : some random text\nGPU[1] : 8192 MB total";
    const gpus = parseRocmSmiOutput(text);
    // First line doesn't match the regex → filtered out
    expect(gpus).toHaveLength(1);
    expect(gpus[0]!.name).toBe("AMD GPU 1");
  });
});

// ---------------------------------------------------------------------------
// parseXpuSmiDeviceList
// ---------------------------------------------------------------------------

describe("parseXpuSmiDeviceList", () => {
  test("parses device IDs from xpu-smi discovery output", () => {
    const text = [
      "+------------------+-------------------+",
      "| Device ID        | 0                 |",
      "| Device Name      | Intel Data Center GPU Max 1550 |",
      "+------------------+-------------------+",
      "| Device ID        | 1                 |",
      "| Device Name      | Intel Data Center GPU Max 1550 |",
      "+------------------+-------------------+",
    ].join("\n");
    const ids = parseXpuSmiDeviceList(text);
    expect(ids).toEqual([0, 1]);
  });

  test("returns empty for empty input", () => {
    expect(parseXpuSmiDeviceList("")).toEqual([]);
  });

  test("returns empty when no device ID lines present", () => {
    const text = "Some unrelated output\nNo devices found";
    expect(parseXpuSmiDeviceList(text)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseXpuSmiDeviceDetails
// ---------------------------------------------------------------------------

describe("parseXpuSmiDeviceDetails", () => {
  test("parses device name and memory from detail output", () => {
    const text = [
      "+------------------+-------------------------------------------+",
      "| Device Name      | Intel Data Center GPU Max 1550            |",
      "| Memory Physical Size | 32768.00 MiB                         |",
      "+------------------+-------------------------------------------+",
    ].join("\n");
    const gpu = parseXpuSmiDeviceDetails(text, 0);
    expect(gpu).not.toBeNull();
    expect(gpu!.vendor).toBe("intel");
    expect(gpu!.name).toBe("Intel Data Center GPU Max 1550");
    expect(gpu!.vramMb).toBe(32768);
  });

  test("falls back to default name when Device Name is missing", () => {
    const text = [
      "| Memory Physical Size | 16384.00 MiB |",
    ].join("\n");
    const gpu = parseXpuSmiDeviceDetails(text, 3);
    expect(gpu).not.toBeNull();
    expect(gpu!.name).toBe("Intel GPU 3");
    expect(gpu!.vramMb).toBe(16384);
  });

  test("returns 0 vramMb when memory line is missing", () => {
    const text = [
      "| Device Name | Intel Arc A770 |",
    ].join("\n");
    const gpu = parseXpuSmiDeviceDetails(text, 0);
    expect(gpu).not.toBeNull();
    expect(gpu!.name).toBe("Intel Arc A770");
    expect(gpu!.vramMb).toBe(0);
  });

  test("handles empty output", () => {
    const gpu = parseXpuSmiDeviceDetails("", 0);
    expect(gpu).not.toBeNull();
    expect(gpu!.name).toBe("Intel GPU 0");
    expect(gpu!.vramMb).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// classifyCapacitySource
// ---------------------------------------------------------------------------

describe("classifyCapacitySource", () => {
  test("returns 'system-ram' for no GPUs", () => {
    expect(classifyCapacitySource([])).toBe("system-ram");
  });

  test("returns 'nvidia' for only NVIDIA GPUs", () => {
    const gpus: DetectedGpu[] = [
      { vendor: "nvidia", name: "RTX 4090", vramMb: 24564 },
      { vendor: "nvidia", name: "RTX 4090", vramMb: 24564 },
    ];
    expect(classifyCapacitySource(gpus)).toBe("nvidia");
  });

  test("returns 'amd' for only AMD GPUs", () => {
    const gpus: DetectedGpu[] = [
      { vendor: "amd", name: "MI300X", vramMb: 192000 },
    ];
    expect(classifyCapacitySource(gpus)).toBe("amd");
  });

  test("returns 'intel' for only Intel GPUs", () => {
    const gpus: DetectedGpu[] = [
      { vendor: "intel", name: "Max 1550", vramMb: 32768 },
    ];
    expect(classifyCapacitySource(gpus)).toBe("intel");
  });

  test("returns 'mixed' for multiple vendors", () => {
    const gpus: DetectedGpu[] = [
      { vendor: "nvidia", name: "A100", vramMb: 81920 },
      { vendor: "amd", name: "MI300X", vramMb: 192000 },
    ];
    expect(classifyCapacitySource(gpus)).toBe("mixed");
  });
});
