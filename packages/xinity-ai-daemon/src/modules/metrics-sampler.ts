import { $ } from "bun";
import { env } from "../env";
import { rootLogger } from "../logger";
import { getHardwareProfile } from "./statekeeper";

const log = rootLogger.child({ name: "metrics-sampler" });

/** One GPU's readings from a single nvidia-smi poll. Nullable fields are "[N/A]" on this device. */
export type GpuMetricSample = {
  index: number;
  uuid: string;
  name: string;
  driverVersion: string | null;
  utilizationPct: number;
  memoryUtilizationPct: number | null;
  temperatureC: number | null;
  powerWatts: number | null;
  powerLimitWatts: number | null;
  memoryUsedMb: number;
  memoryTotalMb: number | null;
  eccUncorrected: number | null;
  eccCorrected: number | null;
};

/** A GPU's latest sample plus state the store tracks across polls. */
export type GpuSnapshot = GpuMetricSample & {
  /** Cumulative integrated energy since the sampler started (Wh). */
  energyWh: number;
  /** Throttling right now, or null when the driver doesn't report it. */
  throttled: boolean | null;
};

export type MetricsSnapshot = {
  gpus: GpuSnapshot[];
  /** Polls that returned no usable data since the sampler started. */
  sampleFailures: number;
};

// ─── Power estimation ────────────────────────────────────────────────────────
//
// When power draw isn't measurable we estimate from utilization and a rough TDP,
// matched by substring against the GPU name. Energy is labeled an approximation,
// so coarse figures are acceptable; the default covers unknown GPUs.

const GPU_TDP_WATTS: [pattern: string, watts: number][] = [
  ["gb10", 100], // DGX Spark / Ascent GX10 class, ~140 W whole-system TDP
  ["h200", 700],
  ["h100", 500], // between PCIe (350 W) and SXM (700 W) variants
  ["a100", 400],
  ["rtx pro 6000", 600],
  ["rtx 6000", 300],
  ["l40", 300],
  ["rtx 5090", 575],
  ["rtx 4090", 450],
];

const DEFAULT_TDP_WATTS = 250;

/** Fraction of TDP a GPU draws when idle. */
const IDLE_POWER_FRACTION = 0.1;

export function estimateTdpWatts(gpuName: string): number {
  const name = gpuName.toLowerCase();
  return GPU_TDP_WATTS.find(([pattern]) => name.includes(pattern))?.[1] ?? DEFAULT_TDP_WATTS;
}

export function estimatePowerWatts(gpuName: string, utilizationPct: number): number {
  const tdp = estimateTdpWatts(gpuName);
  const load = Math.min(Math.max(utilizationPct, 0), 100) / 100;
  return tdp * (IDLE_POWER_FRACTION + (1 - IDLE_POWER_FRACTION) * load);
}

// ─── nvidia-smi sampling ─────────────────────────────────────────────────────

// Stable field names across driver versions. The CSV column order here is the
// order parseNvidiaMetricsLine reads them in.
const GPU_QUERY_FIELDS = [
  "index", "uuid", "name", "driver_version",
  "utilization.gpu", "utilization.memory", "temperature.gpu",
  "power.draw", "power.limit", "memory.used", "memory.total",
  "ecc.errors.uncorrected.volatile.total", "ecc.errors.corrected.volatile.total",
].join(",");

// Throttle reasons were renamed from clocks_throttle_reasons to clocks_event_reasons
// around driver R535. Querying an unknown field fails the whole call, so we probe
// each name independently and remember the one that works.
const THROTTLE_FIELDS = ["clocks_event_reasons.active", "clocks_throttle_reasons.active"];

export function parseNvidiaMetricsOutput(csv: string): GpuMetricSample[] {
  return csv
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseNvidiaMetricsLine)
    .filter((x): x is GpuMetricSample => x !== null);
}

function parseNvidiaMetricsLine(line: string): GpuMetricSample | null {
  const f = line.split(",").map((s) => s.trim());
  const [index, uuid, name, driverVersion, util, memUtil, temp,
    power, powerLimit, memUsed, memTotal, eccUnc, eccCor] = f;
  if (!uuid || !name) return null;

  return {
    index: parseSmiNumber(index) ?? 0,
    uuid,
    name,
    driverVersion: parseSmiString(driverVersion),
    utilizationPct: parseSmiNumber(util) ?? 0,
    memoryUtilizationPct: parseSmiNumber(memUtil),
    temperatureC: parseSmiNumber(temp),
    powerWatts: parseSmiNumber(power),
    powerLimitWatts: parseSmiNumber(powerLimit),
    memoryUsedMb: parseSmiNumber(memUsed) ?? 0,
    memoryTotalMb: parseSmiNumber(memTotal),
    eccUncorrected: parseSmiNumber(eccUnc),
    eccCorrected: parseSmiNumber(eccCor),
  };
}

/** Parse `index, 0xHEX` throttle lines into index -> throttling-now. */
export function parseThrottleOutput(csv: string): Map<number, boolean> {
  const result = new Map<number, boolean>();
  for (const line of csv.split("\n")) {
    const [idx, mask] = line.split(",").map((s) => s.trim());
    const index = parseSmiNumber(idx);
    const bits = parseInt(mask ?? "", 16);
    if (index === null || Number.isNaN(bits)) continue;
    result.set(index, bits !== 0);
  }
  return result;
}

/** nvidia-smi prints "[N/A]" or "N/A" for unsupported fields. */
function parseSmiNumber(value: string | undefined): number | null {
  if (!value) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseSmiString(value: string | undefined): string | null {
  if (!value || value === "[N/A]" || value === "N/A") return null;
  return value;
}

async function sampleNvidiaMetrics(): Promise<GpuMetricSample[]> {
  const output =
    await $`nvidia-smi --query-gpu=${GPU_QUERY_FIELDS} --format=csv,noheader,nounits`
      .throws(false)
      .text();

  if (!output.trim()) return [];
  return parseNvidiaMetricsOutput(output);
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Holds the latest per-GPU sample (keyed by UUID) plus state accumulated across
 * polls: integrated energy, the most recent throttle readings, and a failure
 * count. Gauges read the latest sample; energy is monotonic.
 */
export class GpuMetricsStore {
  private latest = new Map<string, GpuMetricSample>();
  private energyWh = new Map<string, number>();
  private throttled = new Map<number, boolean>();
  private failures = 0;

  /** @param dtMs Wall-clock time this sample covers (since the previous sample). */
  add(gpus: GpuMetricSample[], dtMs: number): void {
    for (const gpu of gpus) {
      this.latest.set(gpu.uuid, gpu);
      const watts = gpu.powerWatts ?? estimatePowerWatts(gpu.name, gpu.utilizationPct);
      this.energyWh.set(gpu.uuid, (this.energyWh.get(gpu.uuid) ?? 0) + (watts * dtMs) / 3_600_000);
    }
  }

  setThrottled(byIndex: Map<number, boolean>): void {
    this.throttled = byIndex;
  }

  recordFailure(): void {
    this.failures += 1;
  }

  snapshot(): MetricsSnapshot {
    const gpus = [...this.latest.values()].map((gpu) => ({
      ...gpu,
      energyWh: this.energyWh.get(gpu.uuid) ?? 0,
      throttled: this.throttled.has(gpu.index) ? this.throttled.get(gpu.index)! : null,
    }));
    return { gpus, sampleFailures: this.failures };
  }

  reset(): void {
    this.latest.clear();
    this.energyWh.clear();
    this.throttled.clear();
    this.failures = 0;
  }
}

// ─── Sampler lifecycle ───────────────────────────────────────────────────────

export type MetricsSampler = {
  stop: () => Promise<void>;
  snapshot: () => MetricsSnapshot | null;
};

/** The store from the currently running sampler, or null if not started. */
let activeStore: GpuMetricsStore | null = null;

/** Returns the latest GPU metrics, or null if the sampler has not started. */
export function getMetricsSnapshot(): MetricsSnapshot | null {
  return activeStore?.snapshot() ?? null;
}

/**
 * Starts periodic GPU sampling. Returns a handle whose stop() clears the timer
 * and snapshot() returns the latest per-GPU data.
 */
export function startMetricsSampler(): MetricsSampler {
  const store = new GpuMetricsStore();
  activeStore = store;
  let lastSampleAt = Date.now();
  let sampling = false;
  let sampleTimer: ReturnType<typeof setInterval> | undefined;

  // undefined = untried, null = no supported field, string = the working field.
  let throttleField: string | null | undefined = undefined;

  async function sampleThrottled(): Promise<Map<number, boolean>> {
    const candidates = throttleField === undefined ? THROTTLE_FIELDS
      : throttleField === null ? []
      : [throttleField];
    for (const field of candidates) {
      const out = await $`nvidia-smi --query-gpu=index,${field} --format=csv,noheader,nounits`
        .throws(false)
        .text();
      const parsed = parseThrottleOutput(out);
      if (parsed.size > 0) {
        throttleField = field;
        return parsed;
      }
    }
    if (throttleField === undefined) throttleField = null;
    return new Map();
  }

  async function sampleOnce() {
    if (sampling) return;
    sampling = true;
    try {
      const now = Date.now();
      // Clamp dt so a suspended/stalled host doesn't integrate into an energy spike.
      const dtMs = Math.min(now - lastSampleAt, env.METRICS_SAMPLE_INTERVAL_MS * 2);
      lastSampleAt = now;

      const gpus = await sampleNvidiaMetrics();
      if (gpus.length === 0) {
        store.recordFailure();
        return;
      }
      store.add(gpus, dtMs);
      store.setThrottled(await sampleThrottled());
    } catch (err) {
      store.recordFailure();
      log.warn({ err }, "GPU sampling failed");
    } finally {
      sampling = false;
    }
  }

  void (async () => {
    const profile = await getHardwareProfile();
    const hasNvidia = profile.gpus.some((g) => g.vendor === "nvidia");
    if (hasNvidia) {
      sampleTimer = setInterval(() => void sampleOnce(), env.METRICS_SAMPLE_INTERVAL_MS);
      void sampleOnce();
    } else if (profile.gpuCount > 0) {
      log.info("GPU telemetry not yet supported for this vendor; sampling deferred");
    }
  })();

  return {
    async stop() {
      clearInterval(sampleTimer);
      activeStore = null;
    },
    snapshot() {
      return store.snapshot();
    },
  };
}
