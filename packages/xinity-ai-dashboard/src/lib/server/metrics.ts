/**
 * Prometheus metrics registry and common counters.
 * Imported by server hooks/routes that report request activity.
 */
import * as promClient from "prom-client";
import { serverEnv } from "$lib/server/serverenv";

const BASIC_PREFIX = "Basic ";

/** Validate a request's Basic auth header against METRICS_AUTH ("user:pass"). */
export function checkMetricsBasicAuth(request: Request): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith(BASIC_PREFIX)) return false;
  const decoded = Buffer.from(authHeader.slice(BASIC_PREFIX.length), "base64").toString();
  return decoded === serverEnv.METRICS_AUTH;
}

/** Open when METRICS_AUTH is unset; otherwise requires a matching Basic auth header. */
export function isMetricsAuthorized(request: Request): boolean {
  if (!serverEnv.METRICS_AUTH) return true;
  return checkMetricsBasicAuth(request);
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
