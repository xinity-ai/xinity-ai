import { $ } from "bun";
import { freemem, totalmem } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "hardware-detect" });

// ─── Types ───────────────────────────────────────────────────────────────────

export type GpuVendor = "nvidia" | "amd" | "intel";

export type DetectedGpu = {
  vendor: GpuVendor;
  name: string;
  /** Total VRAM in megabytes. 0 when detection succeeded but VRAM is unknown (e.g. unified memory). */
  vramMb: number;
};

/** Runtime GPU statistics with current usage information. */
export type GpuRuntimeStats = {
  name: string;
  totalMemory: number;
  usedMemory: number;
  freeMemory: number;
};

export type CapacitySource =
  | "nvidia"
  | "amd"
  | "intel"
  | "mixed"
  | "unified-memory"
  | "system-ram";

export type HardwareProfile = {
  gpus: DetectedGpu[];
  gpuCount: number;
  /** Estimated usable model capacity in GB. */
  detectedCapacityGb: number;
  source: CapacitySource;
};

// ─── Unit conversions ────────────────────────────────────────────────────────

function mbToGb(mb: number): number {
  return Math.floor(mb / 1024);
}

function bytesToMb(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024));
}

function getSystemRamMb(): number {
  return bytesToMb(totalmem());
}

// ─── NVIDIA detection (nvidia-smi) ──────────────────────────────────────────

async function detectNvidiaGpus(): Promise<DetectedGpu[]> {
  const output = await $`nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits`
    .throws(false)
    .text();

  if (!output.trim()) return [];

  return parseNvidiaSmiOutput(output);
}

export function parseNvidiaSmiOutput(csv: string): DetectedGpu[] {
  return csv
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseNvidiaSmiLine)
    .filter((gpu): gpu is DetectedGpu => gpu !== null);
}

function parseNvidiaSmiLine(line: string): DetectedGpu | null {
  const [_index, name, totalMemory] = line.split(",").map((s) => s.trim());
  if (!name) return null;

  return {
    vendor: "nvidia",
    name,
    vramMb: Number(totalMemory) || 0,
  };
}

/** Fetches live NVIDIA GPU stats including usage info. Used by the systemInfo RPC endpoint. */
export async function getNvidiaRuntimeStats(): Promise<GpuRuntimeStats[]> {
  const output =
    await $`nvidia-smi --query-gpu=index,name,memory.total,memory.used,memory.free --format=csv,noheader,nounits`
      .throws(false)
      .text();

  if (!output.trim()) return [];

  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseNvidiaRuntimeLine)
    .filter((s): s is GpuRuntimeStats => s !== null);
}

function parseNvidiaRuntimeLine(line: string): GpuRuntimeStats | null {
  const [_index, name, totalMemory, usedMemory, freeMemory] = line
    .split(",")
    .map((s) => s.trim());
  if (!name) return null;

  return {
    name,
    totalMemory: Number(totalMemory) || 0,
    usedMemory: Number(usedMemory) || 0,
    freeMemory: Number(freeMemory) || 0,
  };
}

// ─── AMD detection ──────────────────────────────────────────────────────────
//
// Primary: /sys/class/drm/ sysfs interface (works with just the kernel driver)
// Fallback: rocm-smi CLI tool

const AMD_PCI_VENDOR_ID = "0x1002";
const DRM_SYSFS_PATH = "/sys/class/drm";

async function detectAmdGpus(): Promise<DetectedGpu[]> {
  const sysfsGpus = await detectAmdGpusSysfs();
  if (sysfsGpus.length > 0) return sysfsGpus;

  return detectAmdGpusRocmSmi();
}

async function detectAmdGpusSysfs(): Promise<DetectedGpu[]> {
  const cards = await listDrmCardsForVendor(AMD_PCI_VENDOR_ID);
  const gpus: DetectedGpu[] = [];

  for (const cardPath of cards) {
    const gpu = await readAmdGpuFromSysfs(cardPath);
    if (gpu) gpus.push(gpu);
  }

  return gpus;
}

async function listDrmCardsForVendor(vendorId: string): Promise<string[]> {
  try {
    const entries = await readdir(DRM_SYSFS_PATH);
    const cardDirs = entries.filter((e) => /^card\d+$/.test(e));

    const matching: string[] = [];
    for (const card of cardDirs) {
      const vendor = await readSysfsFile(`${DRM_SYSFS_PATH}/${card}/device/vendor`);
      if (vendor === vendorId) {
        matching.push(`${DRM_SYSFS_PATH}/${card}`);
      }
    }
    return matching;
  } catch (err) {
    log.debug({ err }, "Failed to read DRM sysfs path, assuming no DRM devices");
    return [];
  }
}

async function readAmdGpuFromSysfs(cardPath: string): Promise<DetectedGpu | null> {
  const vramBytesStr = await readSysfsFile(`${cardPath}/device/mem_info_vram_total`);
  if (!vramBytesStr) return null;

  const vramBytes = Number(vramBytesStr);
  if (isNaN(vramBytes) || vramBytes <= 0) return null;

  const cardName = cardPath.split("/").pop() ?? "AMD GPU";
  return {
    vendor: "amd",
    name: `AMD GPU (${cardName})`,
    vramMb: bytesToMb(vramBytes),
  };
}

async function readSysfsFile(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, "utf-8");
    return content.trim();
  } catch {
    return null;
  }
}

async function detectAmdGpusRocmSmi(): Promise<DetectedGpu[]> {
  const output = await $`rocm-smi --showmeminfo vram`.throws(false).text();

  if (!output.trim()) return [];

  return parseRocmSmiOutput(output);
}

export function parseRocmSmiOutput(text: string): DetectedGpu[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("GPU["))
    .map(parseRocmSmiLine)
    .filter((gpu): gpu is DetectedGpu => gpu !== null);
}

function parseRocmSmiLine(line: string): DetectedGpu | null {
  const match = line.match(
    /GPU\[(\d+)\]\s*:\s*(\d+)\s*MB\s*total/i
  );
  if (!match) return null;

  const [, index, totalMemory] = match;
  return {
    vendor: "amd",
    name: `AMD GPU ${index}`,
    vramMb: Number(totalMemory) || 0,
  };
}

/** Fetches live AMD GPU stats including usage info. Used by the systemInfo RPC endpoint. */
export async function getAmdRuntimeStats(): Promise<GpuRuntimeStats[]> {
  const output = await $`rocm-smi --showmeminfo vram`.throws(false).text();

  if (!output.trim()) return [];

  return output
    .split("\n")
    .filter((line) => line.startsWith("GPU["))
    .map(parseRocmSmiRuntimeLine)
    .filter((s): s is GpuRuntimeStats => s !== null);
}

function parseRocmSmiRuntimeLine(line: string): GpuRuntimeStats | null {
  const match = line.match(
    /GPU\[(\d+)\]\s*:\s*(\d+)\s*MB\s*total,\s*(\d+)\s*MB\s*used,\s*(\d+)\s*MB\s*free/i
  );
  if (!match) return null;

  const [, index, totalMemory, usedMemory, freeMemory] = match;
  return {
    name: `AMD GPU ${index}`,
    totalMemory: Number(totalMemory) || 0,
    usedMemory: Number(usedMemory) || 0,
    freeMemory: Number(freeMemory) || 0,
  };
}

// ─── Intel detection (xpu-smi) ──────────────────────────────────────────────

async function detectIntelGpus(): Promise<DetectedGpu[]> {
  const deviceIds = await listIntelXpuDeviceIds();
  if (deviceIds.length === 0) return [];

  const gpus: DetectedGpu[] = [];
  for (const deviceId of deviceIds) {
    const gpu = await queryIntelGpuDetails(deviceId);
    if (gpu) gpus.push(gpu);
  }
  return gpus;
}

async function listIntelXpuDeviceIds(): Promise<number[]> {
  const output = await $`xpu-smi discovery`.throws(false).text();
  if (!output.trim()) return [];

  return parseXpuSmiDeviceList(output);
}

export function parseXpuSmiDeviceList(text: string): number[] {
  const ids: number[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*\|\s*Device ID\s*\|\s*(\d+)/i);
    if (match) {
      ids.push(Number(match[1]));
    }
  }
  return ids;
}

async function queryIntelGpuDetails(deviceId: number): Promise<DetectedGpu | null> {
  const output = await $`xpu-smi discovery -d ${deviceId}`.throws(false).text();
  if (!output.trim()) return null;

  return parseXpuSmiDeviceDetails(output, deviceId);
}

export function parseXpuSmiDeviceDetails(text: string, deviceId: number): DetectedGpu | null {
  const name = extractXpuSmiField(text, "Device Name") ?? `Intel GPU ${deviceId}`;
  const memorySizeStr = extractXpuSmiField(text, "Memory Physical Size");

  let vramMb = 0;
  if (memorySizeStr) {
    const match = memorySizeStr.match(/([\d.]+)\s*MiB/i);
    if (match) {
      vramMb = Math.floor(Number(match[1]));
    }
  }

  return { vendor: "intel", name, vramMb };
}

function extractXpuSmiField(text: string, fieldName: string): string | null {
  for (const line of text.split("\n")) {
    if (line.includes(fieldName)) {
      const parts = line.split("|").map((s) => s.trim());
      // Typical format: "| Memory Physical Size | 32768.00 MiB |"
      const valuePart = parts.find(
        (p) => p.length > 0 && !p.includes(fieldName)
      );
      if (valuePart) return valuePart;
    }
  }
  return null;
}

// ─── Aggregate detection ────────────────────────────────────────────────────

async function detectAllGpus(): Promise<DetectedGpu[]> {
  const [nvidia, amd, intel] = await Promise.all([
    detectNvidiaGpus(),
    detectAmdGpus(),
    detectIntelGpus(),
  ]);

  return [...nvidia, ...amd, ...intel];
}


export function classifyCapacitySource(gpus: DetectedGpu[]): CapacitySource {
  if (gpus.length === 0) return "system-ram";

  const vendors = new Set(gpus.map((g) => g.vendor));

  if (vendors.size > 1) return "mixed";
  if (vendors.has("nvidia")) return "nvidia";
  if (vendors.has("amd")) return "amd";
  if (vendors.has("intel")) return "intel";

  return "system-ram";
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Detects GPU hardware and determines the node's usable capacity.
 *
 * Detection strategy:
 *  1. Probe NVIDIA, AMD, and Intel GPUs in parallel
 *  2. If GPUs are found with reported VRAM, sum VRAM across all GPUs
 *  3. If GPUs are found but report 0 VRAM: unified memory architecture, use system RAM
 *  4. If no GPUs are found: CPU-only mode, use system RAM
 */
export async function detectHardwareProfile(): Promise<HardwareProfile> {
  const gpus = await detectAllGpus();
  const gpuCount = gpus.length;
  const totalVramMb = gpus.reduce((sum, gpu) => sum + gpu.vramMb, 0);

  if (gpuCount > 0 && totalVramMb > 0) {
    return {
      gpus,
      gpuCount,
      detectedCapacityGb: mbToGb(totalVramMb),
      source: classifyCapacitySource(gpus),
    };
  }

  if (gpuCount > 0 && totalVramMb === 0) {
    // GPUs detected but no VRAM reported, likely unified memory (e.g. NVIDIA Grace Hopper).
    // Fall back to system RAM as capacity, but preserve the GPU count.
    log.warn({ gpuCount }, "GPUs detected but no VRAM reported, assuming unified memory, using system RAM as capacity");
    return {
      gpus,
      gpuCount,
      detectedCapacityGb: 
        // reducing to 90% to ensure enough ram remains for the system
        mbToGb(Math.floor(getSystemRamMb() * 0.9)),
      source: "unified-memory",
    };
  }

  // No GPUs detected, CPU-only node
  log.warn("No GPUs detected, falling back to system RAM for capacity estimation (CPU-only mode)");
  return {
    gpus: [],
    gpuCount: 0,
    detectedCapacityGb: mbToGb(getSystemRamMb()),
    source: "system-ram",
  };
}

/**
 * Query current free memory in MB for the given capacity source.
 *
 * - nvidia: queries nvidia-smi for live free VRAM (works for both dedicated and unified memory GPUs like GB10)
 * - amd: queries rocm-smi for live free VRAM
 * - unified-memory / system-ram / intel / mixed: uses OS free memory
 *
 * Returns null only if the underlying query fails (e.g. nvidia-smi crashes).
 */
export async function getFreeMemoryMb(source: CapacitySource): Promise<number | null> {
  try {
    if (source === "nvidia") {
      const stats = await getNvidiaRuntimeStats();
      if (stats.length === 0) return null;
      return stats.reduce((sum, s) => sum + s.freeMemory, 0);
    }
    if (source === "amd") {
      const stats = await getAmdRuntimeStats();
      if (stats.length === 0) return null;
      return stats.reduce((sum, s) => sum + s.freeMemory, 0);
    }
    // unified-memory, system-ram, intel, mixed: use OS free memory
    return bytesToMb(freemem());
  } catch {
    return null;
  }
}
