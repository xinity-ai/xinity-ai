import {
  createBuildInfo,
  createHttpMetrics,
  createMetricsAuth,
  processMetrics,
  serializeMetrics,
} from "common-env";
import { version } from "../../../../../package.json";
import { serverEnv } from "$lib/server/serverenv";

const metricsAuth = createMetricsAuth(serverEnv.METRICS_AUTH);

export function isMetricsAuthorized(request: Request): boolean {
  return metricsAuth.isAuthorized(request.headers.get("authorization"));
}

export const httpMetrics = createHttpMetrics();

const buildInfo = createBuildInfo("dashboard_build_info", { version });

export function renderMetrics(): string {
  return serializeMetrics([buildInfo, ...httpMetrics.metrics, ...processMetrics()]);
}
