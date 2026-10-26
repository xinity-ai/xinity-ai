import {
  createBuildInfo,
  createCounter,
  createGauge,
  createHistogram,
  createHttpMetrics,
  createMetricsAuth,
  processMetrics,
  serializeMetrics,
} from "common-env";
import { version } from "../../package.json";
import type { CatalogHealth } from "./catalog";

export type CatalogLabel = "models" | "legacy";
export type LimiterLabel = "export" | "api";

export const httpMetrics = createHttpMetrics();

const buildInfo = createBuildInfo("infoserver_build_info", { version });

const catalogModels = createGauge(
  "infoserver_catalog_models",
  "Models the catalog currently serves.",
);

const lastSuccess = createGauge(
  "infoserver_catalog_last_success_timestamp_seconds",
  "Unix time the catalog last swapped in a freshly loaded set of models.",
);

export const refreshesTotal = createCounter(
  "infoserver_catalog_refreshes_total",
  "Catalog refreshes by outcome. A failure keeps serving the previous catalog.",
);

export const refreshDuration = createHistogram(
  "infoserver_catalog_refresh_duration_seconds",
  "Time to re-read the model files and re-fetch includes.",
  [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
);

export const includeFetchFailures = createCounter(
  "infoserver_include_fetch_failures_total",
  "Include URLs that could not be fetched during a refresh.",
);

export const rateLimitedTotal = createCounter(
  "infoserver_rate_limited_total",
  "Requests refused with 429 by a per-client rate limit.",
);

function observeCatalogs(health: Record<CatalogLabel, CatalogHealth>): void {
  for (const [catalog, { modelCount, lastRefreshAt }] of Object.entries(health)) {
    catalogModels.set({ catalog }, modelCount);
    if (lastRefreshAt) {
      lastSuccess.set({ catalog }, Date.parse(lastRefreshAt) / 1000);
    }
  }
}

export function createMetricsHandler(auth: string | undefined, catalogHealth: () => Record<CatalogLabel, CatalogHealth>) {
  const metricsAuth = createMetricsAuth(auth);
  const metrics = [
    buildInfo,
    ...httpMetrics.metrics,
    catalogModels,
    lastSuccess,
    refreshesTotal,
    refreshDuration,
    includeFetchFailures,
    rateLimitedTotal,
  ];

  return (req: Request): Response => {
    if (req.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const authErr = metricsAuth.unauthorized(req.headers.get("authorization"));
    if (authErr) {
      return authErr;
    }
    observeCatalogs(catalogHealth());
    return new Response(serializeMetrics([...metrics, ...processMetrics()]), {
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  };
}
