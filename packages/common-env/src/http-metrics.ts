import { createCounter, createGauge, createHistogram, type Labels, type Metric } from "./metrics-format";

/** Seconds, the base unit every off-the-shelf Prometheus rule assumes. */
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

export type HttpLabels = { method: string; route: string };

export type Handler = (req: Request) => Promise<Response> | Response;

export type HttpMetrics = {
  track<T>(labels: HttpLabels, run: () => T | Promise<T>, statusOf: (result: T) => number): Promise<T>;
  /** `route` becomes the label, so pass a pattern rather than a concrete path. */
  route(route: string, handler: Handler): (req: Request) => Promise<Response>;
  started(labels: HttpLabels): void;
  finished(labels: HttpLabels, status: number, seconds: number): void;
  metrics: Metric[];
};

export function createHttpMetrics(): HttpMetrics {
  const requestsTotal = createCounter(
    "http_requests_total",
    "Total HTTP requests by method, route, and response status.",
  );

  const inFlight = createGauge(
    "http_requests_in_flight",
    "HTTP requests currently being served.",
  );

  const duration = createHistogram(
    "http_request_duration_seconds",
    "HTTP request duration in seconds by method and route.",
    DURATION_BUCKETS,
  );

  const started = (labels: HttpLabels): void => {
    inFlight.inc(labels as Labels);
  };

  const finished = (labels: HttpLabels, status: number, seconds: number): void => {
    inFlight.dec(labels as Labels);
    duration.observe(labels as Labels, seconds);
    requestsTotal.inc({ ...labels, status: String(status) });
  };

  const self: HttpMetrics = {
    started,
    finished,
    route(route, handler) {
      return (req) =>
        self.track(
          { method: req.method, route },
          async () => handler(req),
          (res) => res.status,
        );
    },
    async track(labels, run, statusOf) {
      started(labels);
      const start = performance.now();
      try {
        const result = await run();
        finished(labels, statusOf(result), (performance.now() - start) / 1000);
        return result;
      } catch (err) {
        finished(labels, 500, (performance.now() - start) / 1000);
        throw err;
      }
    },
    metrics: [requestsTotal, inFlight, duration],
  };

  return self;
}
