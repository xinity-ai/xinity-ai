import { createMetricsAuth } from "common-env";
import { env } from "./env";
import { releaseCallbacks } from "./llm-forward/release-registry";
import { isAbortError } from "./llm-forward/util";
import { rootLogger } from "./logger";

const metricsAuth = createMetricsAuth(env.METRICS_AUTH);

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
          break;
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

type ScalarValues = Map<string, { labels: Labels; value: number }>;

function addToLabelGroup(values: ScalarValues, labels: Labels, amount: number) {
  const key = labelKey(labels);
  const existing = values.get(key);
  if (existing) {
    existing.value += amount;
  } else {
    values.set(key, { labels, value: amount });
  }
}

function createCounter(name: string, help: string) {
  const values: ScalarValues = new Map();

  return {
    inc(labels: Labels, amount = 1) {
      addToLabelGroup(values, labels, amount);
    },
    serialize(): string {
      return serializeMetric(name, help, "counter", values);
    },
  };
}

function createGauge(name: string, help: string) {
  const values: ScalarValues = new Map();

  return {
    inc(labels: Labels, amount = 1) {
      addToLabelGroup(values, labels, amount);
    },
    dec(labels: Labels, amount = 1) {
      addToLabelGroup(values, labels, -amount);
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

const DURATION_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000];

export const requestDuration = createHistogram(
  "gateway_request_duration_milliseconds",
  "Request duration in milliseconds by endpoint",
  DURATION_BUCKETS,
);

const TTFT_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

export const timeToFirstToken = createHistogram(
  "gateway_time_to_first_token_milliseconds",
  "Time to first token for streaming responses by deployment",
  TTFT_BUCKETS,
);

export const modelRequestsTotal = createCounter(
  "gateway_model_requests_total",
  "Total requests by model and outcome",
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

const TPS_BUCKETS = [1, 5, 10, 20, 40, 60, 80, 100, 150, 200, 300, 500];

export const generationTokensPerSecond = createHistogram(
  "gateway_generation_tokens_per_second",
  "Output tokens per second by deployment",
  TPS_BUCKETS,
);

const allMetrics = [
  requestsTotal,
  requestErrorsTotal,
  activeRequests,
  requestDuration,
  timeToFirstToken,
  modelRequestsTotal,
  inputTokens,
  outputTokens,
  generationTokensPerSecond,
];

export function recordTokenUsage(
  model: string,
  keyId: string,
  usage: { inputTokens?: number; outputTokens?: number } | null | undefined,
  opts?: { deployment?: string; durationMs?: number },
) {
  if (!usage) return;
  const labels = { model, key_id: keyId };
  if (usage.inputTokens != null) inputTokens.observe(labels, usage.inputTokens);
  if (usage.outputTokens != null) outputTokens.observe(labels, usage.outputTokens);

  if (usage.outputTokens && opts?.deployment && opts.durationMs && opts.durationMs > 0) {
    const tps = usage.outputTokens / (opts.durationMs / 1000);
    generationTokensPerSecond.observe({ deployment: opts.deployment }, tps);
  }
}

export function recordTimeToFirstToken(deployment: string, callStartTime: number): void {
  timeToFirstToken.observe({ deployment }, Date.now() - callStartTime);
}

export function recordModelRequest(model: string, success: boolean): void {
  modelRequestsTotal.inc({ model, status: success ? "success" : "failure" });
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
      requestDuration.observe(labels, Date.now() - start);
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
          // AbortErrors are routine client disconnections, already logged by
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
  const authErr = metricsAuth.unauthorized(req.headers.get("authorization"));
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
