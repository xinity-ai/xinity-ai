/**
 * Prometheus metrics registry and common counters.
 * Imported by server hooks/routes that report request activity.
 */
import * as promClient from "prom-client";
import { createMetricsAuth } from "common-env";
import { serverEnv } from "$lib/server/serverenv";

const metricsAuth = createMetricsAuth(serverEnv.METRICS_AUTH);

export function isMetricsAuthorized(request: Request): boolean {
  return metricsAuth.isAuthorized(request.headers.get("authorization"));
}

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
