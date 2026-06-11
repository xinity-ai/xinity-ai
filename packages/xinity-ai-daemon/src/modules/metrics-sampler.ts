import { $ } from "bun";
import { env } from "../env";
import { rootLogger } from "../logger";
import { getHardwareProfile } from "./statekeeper";

const log = rootLogger.child({ name: "metrics-sampler" });

export type GpuMetricSample = {
  name: string;
  utilizationPct: number;
  /** Null when the driver doesn't report power draw (e.g. "[N/A]" on unified-memory devices). */
  powerWatts: number | null;
  memoryUsedMb: number;
};

// ─── Power estimation ────────────────────────────────────────────────────────
//
// When power draw isn't measurable we estimate from utilization and a rough TDP,
// matched by substring against the GPU name. The fleet page labels energy as an
// approximation, so coarse figures are acceptable; the default covers unknown GPUs.

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

export function parseNvidiaMetricsOutput(csv: string): GpuMetricSample[] {
  return csv
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseNvidiaMetricsLine)
    .filter((x): x is GpuMetricSample => x !== null);
}

function parseNvidiaMetricsLine(line: string): GpuMetricSample | null {
  const [name, utilization, power, memoryUsed] = line.split(",").map((s) => s.trim());
  if (!name) return null;

  return {
    name,
    utilizationPct: parseSmiNumber(utilization) ?? 0,
    powerWatts: parseSmiNumber(power),
    memoryUsedMb: parseSmiNumber(memoryUsed) ?? 0,
  };
}

/** nvidia-smi prints "[N/A]" or "N/A" for unsupported fields. */
function parseSmiNumber(value: string | undefined): number | null {
  if (!value) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function sampleNvidiaMetrics(): Promise<GpuMetricSample[]> {
  const output =
    await $`nvidia-smi --query-gpu=name,utilization.gpu,power.draw,memory.used --format=csv,noheader,nounits`
      .throws(false)
      .text();

  if (!output.trim()) return [];
  return parseNvidiaMetricsOutput(output);
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

export type MetricsBucket = {
  gpuUtilizationAvg: number;
  gpuUtilizationMax: number;
  memoryUsedMb: number;
  powerWattsAvg: number | null;
  energyWh: number;
};

/** Accumulates per-poll GPU samples into one node_metric bucket. */
export class MetricsAccumulator {
  private sampleCount = 0;
  private utilizationSum = 0;
  private utilizationMax = 0;
  private memorySum = 0;
  private powerSum = 0;
  private energyWh = 0;

  /** @param dtMs Wall-clock time this sample covers (since the previous sample). */
  add(gpus: GpuMetricSample[], dtMs: number): void {
    if (gpus.length === 0) return;

    const utilization = gpus.reduce((sum, g) => sum + g.utilizationPct, 0) / gpus.length;
    const memory = gpus.reduce((sum, g) => sum + g.memoryUsedMb, 0);
    const power = gpus.reduce(
      (sum, g) => sum + (g.powerWatts ?? estimatePowerWatts(g.name, g.utilizationPct)),
      0,
    );

    this.sampleCount += 1;
    this.utilizationSum += utilization;
    this.utilizationMax = Math.max(this.utilizationMax, ...gpus.map((g) => g.utilizationPct));
    this.memorySum += memory;
    this.powerSum += power;
    this.energyWh += (power * dtMs) / 3_600_000;
  }

  /** Returns the aggregated bucket, or null when no samples were collected. */
  snapshot(): MetricsBucket | null {
    if (this.sampleCount === 0) return null;
    return {
      gpuUtilizationAvg: this.utilizationSum / this.sampleCount,
      gpuUtilizationMax: this.utilizationMax,
      memoryUsedMb: Math.round(this.memorySum / this.sampleCount),
      powerWattsAvg: this.powerSum / this.sampleCount,
      energyWh: this.energyWh,
    };
  }

  reset(): void {
    this.sampleCount = 0;
    this.utilizationSum = 0;
    this.utilizationMax = 0;
    this.memorySum = 0;
    this.powerSum = 0;
    this.energyWh = 0;
  }
}

// ─── Sampler lifecycle ───────────────────────────────────────────────────────

export type MetricsSampler = { stop: () => Promise<void> };

/**
 * Starts periodic GPU sampling and in-memory aggregation. Accumulated data will
 * feed the Prometheus metrics endpoint when that is added. Returns a handle
 * whose stop() clears the sampling timer.
 */
export function startMetricsSampler(): MetricsSampler {
  const accumulator = new MetricsAccumulator();
  let lastSampleAt = Date.now();
  let sampling = false;
  let sampleTimer: ReturnType<typeof setInterval> | undefined;

  async function sampleOnce() {
    if (sampling) return;
    sampling = true;
    try {
      const now = Date.now();
      // Clamp dt so a suspended/stalled host doesn't integrate into an energy spike.
      const dtMs = Math.min(now - lastSampleAt, env.METRICS_SAMPLE_INTERVAL_MS * 2);
      lastSampleAt = now;
      accumulator.add(await sampleNvidiaMetrics(), dtMs);
    } catch (err) {
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
    },
  };
}
