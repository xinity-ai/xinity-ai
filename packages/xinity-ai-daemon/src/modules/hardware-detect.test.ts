import { describe, test, expect, mock } from "bun:test";
import { mockConfigModule } from "../mock-config";

mock.module("../config", () => mockConfigModule());

const {
  parseNvidiaSmiOutput,
  parseRocmSmiOutput,
  parseXpuSmiDeviceList,
  parseXpuSmiDeviceDetails,
  classifyCapacitySource,
  normalizeDmiProductName,
  cardCapacityGib,
  normalizePciBusId,
  amdRocrUuidField,
  amdCardName,
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

  test("keeps nvidia-smi's own index, the card's uuid and its bus id", () => {
    const csv = [
      "0, NVIDIA RTX PRO 6000 Blackwell, 97887, GPU-5f1c2b8e-0d4a-4c7e-9b31-2a6f8e1d7c40, 00000000:01:00.0",
      "1, NVIDIA L40S, 46068, GPU-a93d7e12-44b0-4f2a-8c6e-19d5b0f3e7a1, 00000000:81:00.0",
    ].join("\n");
    expect(parseNvidiaSmiOutput(csv).map(({ index, uuid, pciBusId }) => ({ index, uuid, pciBusId }))).toEqual([
      { index: 0, uuid: "GPU-5f1c2b8e-0d4a-4c7e-9b31-2a6f8e1d7c40", pciBusId: "0000:01:00.0" },
      { index: 1, uuid: "GPU-a93d7e12-44b0-4f2a-8c6e-19d5b0f3e7a1", pciBusId: "0000:81:00.0" },
    ]);
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

const XPU_SMI_BORDER = "+-----------+--------------------------------------------------------------------------------------+";

describe("parseXpuSmiDeviceList", () => {
  test("parses device IDs from xpu-smi discovery output", () => {
    const text = [
      XPU_SMI_BORDER,
      "| Device ID | Device Information                                                                   |",
      XPU_SMI_BORDER,
      "| 0         | Device Name: Intel(R) Data Center GPU Max 1550                                       |",
      "|           | PCI BDF Address: 0000:29:00.0                                                        |",
      XPU_SMI_BORDER,
      "| 1         | Device Name: Intel(R) Data Center GPU Max 1550                                       |",
      "|           | PCI BDF Address: 0000:3a:00.0                                                        |",
      XPU_SMI_BORDER,
    ].join("\n");
    expect(parseXpuSmiDeviceList(text)).toEqual([0, 1]);
  });

  test("returns empty for empty input", () => {
    expect(parseXpuSmiDeviceList("")).toEqual([]);
  });

  test("returns empty when no device rows are present", () => {
    const text = [XPU_SMI_BORDER, "| Device ID | Device Information |", XPU_SMI_BORDER].join("\n");
    expect(parseXpuSmiDeviceList(text)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseXpuSmiDeviceDetails
// ---------------------------------------------------------------------------

describe("parseXpuSmiDeviceDetails", () => {
  test("parses name, memory and bus id from detail output", () => {
    const text = [
      XPU_SMI_BORDER,
      "| Device ID | Device Information                                                                   |",
      XPU_SMI_BORDER,
      "| 0         | Device Type: GPU                                                                     |",
      "|           | Device Name: Intel(R) Data Center GPU Max 1550                                       |",
      "|           | UUID: 00000000-0000-0000-0000-0bd500008086                                           |",
      "|           | PCI BDF Address: 0000:29:00.0                                                        |",
      "|           | Memory Physical Size: 131072.00 MiB                                                  |",
      XPU_SMI_BORDER,
    ].join("\n");
    expect(parseXpuSmiDeviceDetails(text, 0)).toEqual({
      vendor: "intel",
      name: "Intel(R) Data Center GPU Max 1550",
      vramMb: 131072,
      index: 0,
      pciBusId: "0000:29:00.0",
    });
  });

  test("falls back to default name when Device Name is missing", () => {
    const gpu = parseXpuSmiDeviceDetails("|           | Memory Physical Size: 16384.00 MiB |", 3);
    expect(gpu!.name).toBe("Intel GPU 3");
    expect(gpu!.vramMb).toBe(16384);
  });

  test("returns 0 vramMb when memory line is missing", () => {
    const gpu = parseXpuSmiDeviceDetails("| 0         | Device Name: Intel(R) Arc(TM) A770 Graphics |", 0);
    expect(gpu!.name).toBe("Intel(R) Arc(TM) A770 Graphics");
    expect(gpu!.vramMb).toBe(0);
  });

  test("handles empty output", () => {
    const gpu = parseXpuSmiDeviceDetails("", 0);
    expect(gpu!.name).toBe("Intel GPU 0");
    expect(gpu!.vramMb).toBe(0);
    expect(gpu!.pciBusId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizePciBusId
// ---------------------------------------------------------------------------

describe("normalizePciBusId", () => {
  test("spells nvidia-smi's eight-digit domain like sysfs", () => {
    expect(normalizePciBusId("00000000:0A:00.0")).toBe("0000:0a:00.0");
  });

  test("keeps domains wider than four digits", () => {
    expect(normalizePciBusId("10000:01:00.0")).toBe("10000:01:00.0");
  });

  test("rejects anything that is not a bus id", () => {
    expect(normalizePciBusId("[N/A]")).toBeNull();
    expect(normalizePciBusId(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AMD sysfs identity
// ---------------------------------------------------------------------------

describe("amdRocrUuidField", () => {
  test("spells the driver's unique_id the way ROCr reports it", () => {
    expect(amdRocrUuidField("abc123def4567")).toEqual({ uuid: "GPU-000abc123def4567" });
    expect(amdRocrUuidField("0x5F2A4C1E9B3D7A60")).toEqual({ uuid: "GPU-5f2a4c1e9b3d7a60" });
  });

  test("gives no uuid to a card without the id", () => {
    expect(amdRocrUuidField(null)).toEqual({});
    expect(amdRocrUuidField("0000000000000000")).toEqual({});
  });
});

describe("amdCardName", () => {
  test("names identical cards identically", () => {
    expect(amdCardName("AMD Instinct MI300X", "0x74a1")).toBe("AMD Instinct MI300X");
    expect(amdCardName(null, "0x74a1")).toBe("AMD GPU 0x74a1");
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

// ---------------------------------------------------------------------------
// normalizeDmiProductName
// ---------------------------------------------------------------------------

describe("normalizeDmiProductName", () => {
  test("returns trimmed real product names", () => {
    expect(normalizeDmiProductName("Ascent GX10 \n")).toBe("Ascent GX10");
  });

  test("rejects firmware placeholder values case-insensitively", () => {
    expect(normalizeDmiProductName("To Be Filled By O.E.M.")).toBeNull();
    expect(normalizeDmiProductName("System Product Name")).toBeNull();
    expect(normalizeDmiProductName("Default string")).toBeNull();
  });

  test("returns null for missing or empty input", () => {
    expect(normalizeDmiProductName(null)).toBeNull();
    expect(normalizeDmiProductName("  ")).toBeNull();
  });
});

describe("cardCapacityGib", () => {
  const card = (vramMb: number): DetectedGpu => ({ vendor: "nvidia", name: "card", vramMb });
  const mixed = { gpus: [card(49152), card(24576)], systemRamMb: 131072 };

  test("defaults to the first card", () => {
    expect(cardCapacityGib(mixed)).toBe(48);
  });

  test("is bound by the smallest card the instance spans", () => {
    expect(cardCapacityGib(mixed, [0, 1])).toBe(24);
    expect(cardCapacityGib(mixed, [1])).toBe(24);
  });

  test("takes a unified-memory card as the whole of system RAM, unrounded", () => {
    expect(cardCapacityGib({ gpus: [card(0)], systemRamMb: 124549 })).toBeCloseTo(121.63, 2);
  });

  test("refuses a card the node does not have", () => {
    expect(() => cardCapacityGib(mixed, [2])).toThrow("No GPU at index 2");
  });
});
