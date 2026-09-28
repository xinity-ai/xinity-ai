import {
  createBuildInfo,
  createCounter,
  createGauge,
  createHttpMetrics,
  createMetricsAuth,
  processMetrics,
  serializeMetrics,
  type Labels,
  type Metric,
} from "common-env";
import { version } from "../../../../../package.json";
import { config } from "../../config";
import { rootLogger } from "../../logger";
import { getMetricsSnapshot, type GpuSnapshot } from "../metrics-sampler";
import { listInstallations } from "../model-registry";
import { getNodeId, getMachineName } from "../statekeeper";

const log = rootLogger.child({ name: "metrics" });

const metricsAuth = createMetricsAuth(config.metrics.auth);

const ENGINE_SCRAPE_TIMEOUT_MS = 2000;

export const httpMetrics = createHttpMetrics();

/** Round to a fixed precision and drop trailing zeros. */
function round(value: number, dp: number): number {
  return Number(value.toFixed(dp));
}

/** A per-GPU gauge that skips GPUs whose value isn't reported. */
function gpuGauge(
  name: string,
  help: string,
  gpus: GpuSnapshot[],
  labelsFor: (g: GpuSnapshot) => Labels,
  valueFor: (g: GpuSnapshot) => number | null,
): Metric {
  const gauge = createGauge(name, help);
  for (const g of gpus) {
    const value = valueFor(g);
    if (value !== null) {
      gauge.set(labelsFor(g), value);
    }
  }
  return gauge;
}

// vLLM also serves process and http collectors whose family names collide with the daemon's own.
function vllmSeriesOnly(body: string): string {
  const kept = body.split("\n").filter((line) => {
    if (line.startsWith("# HELP ") || line.startsWith("# TYPE ")) {
      return line.split(" ")[2]?.startsWith("vllm:") ?? false;
    }
    return line.startsWith("vllm:");
  });
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

async function scrapeEngines(): Promise<string[]> {
  const engines = listInstallations().filter((inst) => inst.driver === "vllm");

  const results = await Promise.allSettled(engines.map(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      signal: AbortSignal.timeout(ENGINE_SCRAPE_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  }));

  const bodies: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      const series = vllmSeriesOnly(result.value);
      if (series !== "") {
        bodies.push(series);
      }
    } else {
      log.debug({ err: result.reason, specifier: engines[index]?.specifier }, "Engine metrics scrape failed");
    }
  }
  return bodies;
}

function metricsResponse(metrics: Metric[], engineBodies: string[]): Response {
  const daemon = serializeMetrics([...metrics, ...httpMetrics.metrics, ...processMetrics()]);
  return new Response([daemon, ...engineBodies].join("\n"), {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}

export async function handleDaemonMetrics(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const authErr = metricsAuth.unauthorized(req.headers.get("authorization"));
  if (authErr) {
    return authErr;
  }

  const engineBodies = await scrapeEngines();
  const node: Labels = { node_id: await getNodeId(), machine_name: getMachineName() };

  const up = createGauge("daemon_up", "1 when the daemon process is running.");
  up.set(node, 1);

  const buildInfo = createBuildInfo("daemon_build_info", { ...node, version });

  const snapshot = getMetricsSnapshot();
  if (snapshot === null) {
    return metricsResponse([up, buildInfo], engineBodies);
  }

  const sampleFailures = createCounter(
    "daemon_gpu_sample_failures_total",
    "GPU telemetry polls that returned no usable data since daemon start.",
  );
  sampleFailures.inc(node, snapshot.sampleFailures);

  const gpus = snapshot.gpus;
  const labels = (g: GpuSnapshot): Labels => ({ ...node, gpu: String(g.index), uuid: g.uuid });

  const info = createGauge("daemon_gpu_info", "GPU identity. The value is always 1.");
  for (const g of gpus) {
    info.set({ ...labels(g), name: g.name, driver_version: g.driverVersion ?? "" }, 1);
  }

  const eccErrors = createCounter("daemon_gpu_ecc_errors_total", "GPU ECC error count by type.");
  for (const g of gpus) {
    if (g.eccUncorrected !== null) {
      eccErrors.inc({ ...labels(g), type: "uncorrected" }, g.eccUncorrected);
    }
    if (g.eccCorrected !== null) {
      eccErrors.inc({ ...labels(g), type: "corrected" }, g.eccCorrected);
    }
  }

  const energy = createCounter(
    "daemon_gpu_energy_wh_total",
    "GPU energy consumed since daemon start (Wh).",
  );
  for (const g of gpus) {
    energy.inc(labels(g), round(g.energyWh, 4));
  }

  return metricsResponse([
    up,
    buildInfo,
    sampleFailures,
    info,
    gpuGauge("daemon_gpu_utilization_percent", "GPU compute utilization (0-100).",
      gpus, labels, (g) => round(g.utilizationPct, 2)),
    gpuGauge("daemon_gpu_memory_utilization_percent", "GPU memory-controller utilization (0-100).",
      gpus, labels, (g) => (g.memoryUtilizationPct === null ? null : round(g.memoryUtilizationPct, 2))),
    gpuGauge("daemon_gpu_memory_used_mb", "GPU memory in use (MiB).",
      gpus, labels, (g) => g.memoryUsedMb),
    gpuGauge("daemon_gpu_memory_total_mb", "Total GPU memory (MiB).",
      gpus, labels, (g) => g.memoryTotalMb),
    gpuGauge("daemon_gpu_temperature_celsius", "GPU core temperature (°C).",
      gpus, labels, (g) => g.temperatureC),
    gpuGauge("daemon_gpu_power_draw_watts", "Measured GPU power draw (W).",
      gpus, labels, (g) => (g.powerWatts === null ? null : round(g.powerWatts, 2))),
    gpuGauge("daemon_gpu_power_limit_watts", "GPU power limit (W).",
      gpus, labels, (g) => (g.powerLimitWatts === null ? null : round(g.powerLimitWatts, 2))),
    gpuGauge("daemon_gpu_throttled", "1 when the GPU is currently throttling clocks.",
      gpus, labels, (g) => (g.throttled === null ? null : g.throttled ? 1 : 0)),
    eccErrors,
    energy,
  ], engineBodies);
}
