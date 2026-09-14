import {
  createBuildInfo,
  createHttpMetrics,
  createMetricsAuth,
  processMetrics,
  serializeMetrics,
} from "common-env";
import { version } from "../../../../../package.json";
import { config } from "$lib/server/config";

const metricsAuth = createMetricsAuth(config.metrics.auth);

export function isMetricsAuthorized(request: Request): boolean {
  return metricsAuth.isAuthorized(request.headers.get("authorization"));
}

export const httpMetrics = createHttpMetrics();

const buildInfo = createBuildInfo("dashboard_build_info", { version });

export function renderMetrics(): string {
  return serializeMetrics([buildInfo, ...httpMetrics.metrics, ...processMetrics()]);
}
