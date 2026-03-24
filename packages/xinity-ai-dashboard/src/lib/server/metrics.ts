/**
 * Prometheus metrics registry and common counters.
 * Imported by server hooks/routes that report request activity.
 */
import * as promClient from "prom-client";

export const metricRegister = new promClient.Registry();

/**
 * Global HTTP request counter labeled by method and normalized route.
 */
export const httpRequestCountMetric = new promClient.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route"] as const,
  registers: [metricRegister],
});

promClient.collectDefaultMetrics({ register: metricRegister });
