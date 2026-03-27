import { env } from "./env";
import { releaseCallbacks } from "./llm-forward/release-registry";
import { isAbortError } from "./llm-forward/util";
import { rootLogger } from "./logger";

// Metrics basic auth: comma-separated "user:pass" pairs, e.g. "admin:secret,reader:abc123"
const METRICS_AUTH: Array<{ user: string; pass: string }> = (() => {
  const raw = env.METRICS_AUTH;
  if (!raw) return [];
  return raw.split(",").map((pair) => {
    const sep = pair.indexOf(":");
    if (sep === -1)
      throw new Error(`Invalid METRICS_AUTH entry (missing ':'): "${pair}"`);
    return { user: pair.slice(0, sep), pass: pair.slice(sep + 1) };
  });
})();

const UNAUTHORIZED = (message = "Unauthorized") =>
  new Response(message, {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="metrics"' },
  });

function checkMetricsAuth(req: Request): Response | null {
  if (METRICS_AUTH.length === 0) return null; // no auth configured → open

  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return UNAUTHORIZED();

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return UNAUTHORIZED();
  }

  const sep = decoded.indexOf(":");
  if (sep === -1) return UNAUTHORIZED();

  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);

  if (!METRICS_AUTH.some((a) => a.user === user && a.pass === pass)) {
    return UNAUTHORIZED();
  }

  return null; // authorized
}

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
}

function serializeMetric(
  name: string,
  help: string,
  type: string,
  values: Map<string, { labels: Labels; value: number }>,
): string {
  if (values.size === 0) return "";
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const { labels, value } of values.values()) {
    lines.push(`${name}{${labelKey(labels)}} ${value}`);
  }
  return lines.join("\n");
}

type HistogramEntry = { labels: Labels; sum: number; count: number; buckets: number[] };

function createHistogram(name: string, help: string, boundaries: number[]) {
  const sorted = [...boundaries].sort((a, b) => a - b);
  const values = new Map<string, HistogramEntry>();

  return {
    observe(labels: Labels, value: number) {
      const key = labelKey(labels);
      let entry = values.get(key);
      if (!entry) {
        entry = { labels, sum: 0, count: 0, buckets: new Array(sorted.length).fill(0) };
        values.set(key, entry);
      }
      entry.sum += value;
      entry.count += 1;
      for (let i = 0; i < sorted.length; i++) {
        if (value <= sorted[i]!) {
          entry.buckets[i]! += 1;
        }
      }
    },
    serialize(): string {
      if (values.size === 0) return "";
      const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
      for (const { labels, sum, count, buckets } of values.values()) {
        const lk = labelKey(labels);
        const prefix = lk ? `${lk},` : "";
        let cumulative = 0;
        for (let i = 0; i < sorted.length; i++) {
          cumulative += buckets[i]!;
          lines.push(`${name}_bucket{${prefix}le="${sorted[i]}"} ${cumulative}`);
        }
        lines.push(`${name}_bucket{${prefix}le="+Inf"} ${count}`);
        lines.push(`${name}_sum{${lk}} ${sum}`);
        lines.push(`${name}_count{${lk}} ${count}`);
      }
      return lines.join("\n");
    },
  };
}

function createCounter(name: string, help: string) {
  const values = new Map<string, { labels: Labels; value: number }>();

  return {
    inc(labels: Labels, amount = 1) {
      const key = labelKey(labels);
      const existing = values.get(key);
      if (existing) {
        existing.value += amount;
      } else {
        values.set(key, { labels, value: amount });
      }
    },
    serialize(): string {
      return serializeMetric(name, help, "counter", values);
    },
  };
}

function createGauge(name: string, help: string) {
  const values = new Map<string, { labels: Labels; value: number }>();

  return {
    inc(labels: Labels, amount = 1) {
      const key = labelKey(labels);
      const existing = values.get(key);
      if (existing) {
        existing.value += amount;
      } else {
        values.set(key, { labels, value: amount });
      }
    },
    dec(labels: Labels, amount = 1) {
      this.inc(labels, -amount);
    },
    serialize(): string {
      return serializeMetric(name, help, "gauge", values);
    },
  };
}

export const requestsTotal = createCounter(
  "gateway_requests_total",
  "Total HTTP requests by endpoint and status code",
);

export const requestErrorsTotal = createCounter(
  "gateway_request_errors_total",
  "Total failed requests by endpoint",
);

export const activeRequests = createGauge(
  "gateway_active_requests",
  "Currently in-flight requests by endpoint",
);

export const requestDurationMs = createCounter(
  "gateway_request_duration_milliseconds_total",
  "Cumulative request duration in milliseconds by endpoint",
);

const TOKEN_BUCKETS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

export const inputTokens = createHistogram(
  "gateway_input_tokens",
  "Input tokens per request by model and API key",
  TOKEN_BUCKETS,
);

export const outputTokens = createHistogram(
  "gateway_output_tokens",
  "Output tokens per request by model and API key",
  TOKEN_BUCKETS,
);

const allMetrics = [
  requestsTotal,
  requestErrorsTotal,
  activeRequests,
  requestDurationMs,
  inputTokens,
  outputTokens,
];

export function recordTokenUsage(
  model: string,
  keyId: string,
  usage: { inputTokens?: number; outputTokens?: number } | null | undefined,
) {
  if (!usage) return;
  const labels = { model, key_id: keyId };
  if (usage.inputTokens) inputTokens.observe(labels, usage.inputTokens);
  if (usage.outputTokens) outputTokens.observe(labels, usage.outputTokens);
}

export function withMetrics(
  endpoint: string,
  handler: (req: Request) => Promise<Response> | Response,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const labels = { endpoint };
    activeRequests.inc(labels);
    const start = Date.now();

    const cleanup = () => {
      activeRequests.dec(labels);
      requestDurationMs.inc(labels, Date.now() - start);
      releaseCallbacks.get(req)?.();
      releaseCallbacks.delete(req);
    };

    let deferred = false;
    try {
      const res = await handler(req);
      requestsTotal.inc({ endpoint, status: String(res.status) });
      if (res.status >= 400) requestErrorsTotal.inc(labels);

      // For streaming responses, defer cleanup until the stream finishes
      if (res.body && res.headers.get("content-type")?.includes("text/event-stream")) {
        deferred = true;
        const { readable, writable } = new TransformStream();
        res.body.pipeTo(writable).catch((err) => {
          // AbortErrors are routine client disconnections — already logged by
          // the stream handler. Anything else is unexpected so log as warning.
          if (!isAbortError(err)) {
            rootLogger.warn({ err, endpoint }, "Stream pipe error");
          }
        }).finally(cleanup);
        return new Response(readable, {
          status: res.status,
          headers: res.headers,
        });
      }

      return res;
    } catch (err) {
      requestErrorsTotal.inc(labels);
      requestsTotal.inc({ endpoint, status: "500" });
      throw err;
    } finally {
      if (!deferred) cleanup();
    }
  };
}

export function handleMetrics(req: Request): Response {
  const authErr = checkMetricsAuth(req);
  if (authErr) return authErr;

  const body =
    allMetrics
      .map((m) => m.serialize())
      .filter(Boolean)
      .join("\n\n") + "\n";

  return new Response(body, {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
