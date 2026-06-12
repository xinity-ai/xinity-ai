import { env } from "../../env";
import { getMetricsSnapshot } from "../metrics-sampler";
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

function gauge(name: string, help: string, labels: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name}{${labels}} ${value}`;
}

function counter(name: string, help: string, labels: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name}{${labels}} ${value}`;
}

export async function handleDaemonMetrics(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const authErr = checkMetricsAuth(req);
  if (authErr) return authErr;

  const nodeId = await getNodeId();
  const labels = `node_id="${nodeId}"`;
  const snapshot = getMetricsSnapshot();

  const blocks: string[] = [
    gauge("daemon_up", "1 when the daemon process is running.", labels, 1),
  ];

  if (snapshot !== null) {
    blocks.push(
      gauge("daemon_gpu_utilization_avg", "Average GPU utilization across all GPUs (0-100).", labels, parseFloat(snapshot.gpuUtilizationAvg.toFixed(2))),
      gauge("daemon_gpu_utilization_max", "Peak GPU utilization across all GPUs since last reset (0-100).", labels, parseFloat(snapshot.gpuUtilizationMax.toFixed(2))),
      gauge("daemon_gpu_memory_used_mb", "Average GPU memory used across all GPUs (MiB).", labels, snapshot.memoryUsedMb),
    );
    if (snapshot.powerWattsAvg !== null) {
      blocks.push(gauge("daemon_gpu_power_draw_watts", "Average GPU power draw across all GPUs (W).", labels, parseFloat(snapshot.powerWattsAvg.toFixed(2))));
    }
    blocks.push(counter("daemon_gpu_energy_wh_total", "Total GPU energy consumed since daemon start (Wh).", labels, parseFloat(snapshot.energyWh.toFixed(4))));
  }

  return new Response(blocks.join("\n\n") + "\n", {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
