import { env } from "../../env";
import { getMetricsSnapshot, type GpuSnapshot } from "../metrics-sampler";
import { getNodeId } from "../statekeeper";

function parseUserPass(value: string): { user: string; pass: string } | null {
  const sep = value.indexOf(":");
  if (sep === -1) return null;
  return { user: value.slice(0, sep), pass: value.slice(sep + 1) };
}

// Comma-separated "user:pass" pairs, matching the gateway convention.
const METRICS_AUTH: Array<{ user: string; pass: string }> = (() => {
  const raw = env.METRICS_AUTH;
  if (!raw) return [];
  return raw.split(",").map((pair) => {
    const parsed = parseUserPass(pair);
    if (!parsed) throw new Error(`Invalid METRICS_AUTH entry (missing ':'): "${pair}"`);
    return parsed;
  });
})();

const UNAUTHORIZED = new Response("Unauthorized", {
  status: 401,
  headers: { "WWW-Authenticate": 'Basic realm="metrics"' },
});

function checkMetricsAuth(req: Request): Response | null {
  if (METRICS_AUTH.length === 0) return null;

  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return UNAUTHORIZED;

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return UNAUTHORIZED;
  }

  const credentials = parseUserPass(decoded);
  if (!credentials) return UNAUTHORIZED;

  if (!METRICS_AUTH.some((a) => a.user === credentials.user && a.pass === credentials.pass)) {
    return UNAUTHORIZED;
  }

  return null;
}

/** Escape a Prometheus label value (backslash and double-quote). */
function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Round to a fixed precision and drop trailing zeros. */
function round(value: number, dp: number): number {
  return Number(value.toFixed(dp));
}

/** A metric family: one HELP/TYPE header followed by its sample lines, or "" when empty. */
function family(name: string, help: string, type: "gauge" | "counter", lines: string[]): string {
  if (lines.length === 0) return "";
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines].join("\n");
}

/** A per-GPU gauge that skips GPUs whose value isn't reported. */
function gpuGauge(
  name: string,
  help: string,
  gpus: GpuSnapshot[],
  labelsFor: (g: GpuSnapshot) => string,
  valueFor: (g: GpuSnapshot) => number | null,
): string {
  const lines: string[] = [];
  for (const g of gpus) {
    const value = valueFor(g);
    if (value !== null) lines.push(`${name}{${labelsFor(g)}} ${value}`);
  }
  return family(name, help, "gauge", lines);
}

export async function handleDaemonMetrics(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const authErr = checkMetricsAuth(req);
  if (authErr) return authErr;

  const node = `node_id="${esc(await getNodeId())}"`;
  const snapshot = getMetricsSnapshot();

  const blocks: string[] = [
    family("daemon_up", "1 when the daemon process is running.", "gauge", [`daemon_up{${node}} 1`]),
  ];

  if (snapshot !== null) {
    blocks.push(family(
      "daemon_gpu_sample_failures_total",
      "GPU telemetry polls that returned no usable data since daemon start.",
      "counter",
      [`daemon_gpu_sample_failures_total{${node}} ${snapshot.sampleFailures}`],
    ));

    const gpus = snapshot.gpus;
    const labels = (g: GpuSnapshot) => `${node},gpu="${g.index}",uuid="${esc(g.uuid)}"`;

    blocks.push(
      family("daemon_gpu_info", "GPU identity; value is always 1.", "gauge",
        gpus.map((g) => `daemon_gpu_info{${labels(g)},name="${esc(g.name)}",driver_version="${esc(g.driverVersion ?? "")}"} 1`)),

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

      family("daemon_gpu_ecc_errors_total", "GPU ECC error count by type.", "counter", [
        ...gpus.filter((g) => g.eccUncorrected !== null)
          .map((g) => `daemon_gpu_ecc_errors_total{${labels(g)},type="uncorrected"} ${g.eccUncorrected}`),
        ...gpus.filter((g) => g.eccCorrected !== null)
          .map((g) => `daemon_gpu_ecc_errors_total{${labels(g)},type="corrected"} ${g.eccCorrected}`),
      ]),

      family("daemon_gpu_energy_wh_total", "GPU energy consumed since daemon start (Wh).", "counter",
        gpus.map((g) => `daemon_gpu_energy_wh_total{${labels(g)}} ${round(g.energyWh, 4)}`)),
    );
  }

  const body = blocks.filter(Boolean).join("\n\n") + "\n";
  return new Response(body, {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
