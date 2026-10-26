import "zod/compile";

import { createHealthHandler, deprecations, parseMetricsAuth, probeOwnHealth } from "common-env";
import { createLegacyModelJsonSchema, createModelJsonSchema } from "common-env/model-catalog";
import { version } from "../../package.json";
import { config } from "./config";
import { rootLogger } from "./logger";
import * as catalog from "./server-catalog";
import { legacyCatalog, modelCatalog } from "./server-catalog";
import { handleModelList, handleModelsByFamily, handleModelBySpecifier, handleBatchResolve } from "./api-handlers.legacy";
import { matchesEtag } from "./http-cache";
import { resolveClientIp } from "./client-ip";
import { createRateLimiter, withRateLimit, type RateLimiter, type RouteHandler } from "./rate-limit";
import type { SerializedCatalog } from "./catalog";
import { createMetricsHandler, httpMetrics, rateLimitedTotal, type LimiterLabel } from "./metrics";

const port = config.server.port;

// The container healthcheck: the image ships no curl, so the binary asks the running instance itself.
if (Bun.argv.includes("--health")) {
  process.exit(await probeOwnHealth({ port, tls: false }) ? 0 : 1);
}

catalog.configure(config.catalog.maxIncludeDepth, config.catalog.infoDir, config.catalog.legacyDir);

// The refresh above is the validation: it throws on anything this server could not
// serve. `--check` is how CI asks that question without leaving a server running.
await catalog.refresh();
if (Bun.argv.includes("--check")) {
  process.exit(0);
}

catalog.startAutoRefresh(config.catalog.refreshIntervalMs);

const CACHE_CONTROL = `public, max-age=${Math.floor(config.catalog.refreshIntervalMs / 1000)}`;

/** No Sunset header: RFC 8594 wants a date, and the removal is pinned to a version. */
const DEPRECATION_HEADERS: Record<string, string> = {
  Deprecation: `@${Date.parse(deprecations["infoserver.legacy-model-dir"].deprecatedSince) / 1000}`,
  Link: '<https://github.com/xinity-ai/xinity-ai/blob/main/packages/xinity-infoserver/README.md#model-format-versions>; rel="deprecation"',
};

const limiters: Record<LimiterLabel, RateLimiter> = {
  export: createRateLimiter({ perMinute: config.rateLimit.exportPerMinute }),
  api: createRateLimiter({ perMinute: config.rateLimit.apiPerMinute }),
};

const clientIpConfig = config.proxy;

function limited(limiter: LimiterLabel, handler: RouteHandler): RouteHandler {
  if (!config.rateLimit.enabled) {
    return handler;
  }
  const guarded = withRateLimit(
    limiters[limiter],
    (req, server) => resolveClientIp(req, server, clientIpConfig),
    handler,
  );
  return async (req, server) => {
    const res = await guarded(req, server);
    if (res.status === 429) {
      rateLimitedTotal.inc({ limiter });
    }
    return res;
  };
}

function metered(route: string, handler: RouteHandler): RouteHandler {
  return (req, server) => httpMetrics.track({ method: req.method, route }, () => handler(req, server), (res) => res.status);
}

function legacyRoute(handler: RouteHandler): RouteHandler {
  return async (req, server) => {
    const res = await handler(req, server);
    for (const [header, value] of Object.entries(DEPRECATION_HEADERS)) {
      res.headers.set(header, value);
    }
    return res;
  };
}

function serveCatalogBody(
  source: { getSerializedCatalog: () => SerializedCatalog },
  pick: (serialized: SerializedCatalog) => string,
  contentType: string,
): RouteHandler {
  return (req) => {
    const serialized = source.getSerializedCatalog();
    const etag = `"${serialized.digest}"`;
    const validators = { ETag: etag, "Cache-Control": CACHE_CONTROL };

    if (matchesEtag(req.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers: validators });
    }
    return new Response(pick(serialized), {
      headers: { ...validators, "Content-Type": contentType },
    });
  };
}

// A failed refresh keeps serving the last good catalog, so it degrades the service without
// taking it out of rotation.
const handleHealth = createHealthHandler({
  readiness: {
    models: () => {
      const { models, legacy } = catalog.getCatalogHealth();
      return models.modelCount + legacy.modelCount > 0 ? null : "no models loaded";
    },
  },
  degraded: {
    refresh: () => {
      const { models, legacy } = catalog.getCatalogHealth();
      return models.lastRefreshError ?? legacy.lastRefreshError;
    },
  },
  details: catalog.getCatalogHealth,
  deprecations: {
    "infoserver.legacy-model-dir": async () => config.catalog.legacyDir
      ? `MODEL_LEGACY_DIR is set and serves ${catalog.getCatalogHealth().legacy.modelCount} v1 entries. Move them to MODEL_INFO_DIR in the current format, then unset it.`
      : null,
  },
  credentials: parseMetricsAuth(config.metrics.auth),
});

const handlerRoutes: Record<string, RouteHandler> = {
  "/health": handleHealth,

  "/models/v2.json": limited("export", serveCatalogBody(modelCatalog, s => s.json, "application/json; charset=utf-8")),
  // Exists so polling for change is cheap enough to leave on a loose ceiling,
  // which a conditional GET of the catalog itself cannot be: it shares a URL
  // with the full fetch, so the two cannot be limited apart.
  "/models/v2.digest.json": limited("api", () => Response.json(
    { digest: modelCatalog.getSerializedCatalog().digest },
    { headers: { "Cache-Control": CACHE_CONTROL } },
  )),

  // Deprecated v1 surface, removed before 1.0.0. Serves MODEL_LEGACY_DIR only.
  "/models/v1.yaml": legacyRoute(limited("export", serveCatalogBody(legacyCatalog, s => s.yaml, "application/yaml"))),
  "/models/v1.json": legacyRoute(limited("export", serveCatalogBody(legacyCatalog, s => s.json, "application/json; charset=utf-8"))),
  "/api/v1/models": legacyRoute(limited("api", handleModelList)),
  "/api/v1/models/resolve": legacyRoute(limited("api", handleBatchResolve)),
  "/api/v1/models/family/:family": legacyRoute(limited("api", handleModelsByFamily)),
  "/api/v1/models/:specifier": legacyRoute(limited("api", handleModelBySpecifier)),
};

const server = Bun.serve({
  port,
  routes: {
    "/version.json": Response.json({ version }),
    "/schemas/model.v2.json": Response.json(createModelJsonSchema()),
    "/schemas/model.v1.json": new Response(JSON.stringify(createLegacyModelJsonSchema()), {
      headers: { "Content-Type": "application/json; charset=utf-8", ...DEPRECATION_HEADERS },
    }),
    "/metrics": createMetricsHandler(config.metrics.auth, catalog.getCatalogHealth),
    ...Object.fromEntries(Object.entries(handlerRoutes).map(([route, handler]) => [route, metered(route, handler)])),
  },
  fetch: metered("<unmatched>", () => new Response("Not Found", { status: 404 })),
});

if (config.rateLimit.enabled) {
  setInterval(() => {
    for (const limiter of Object.values(limiters)) {
      limiter.sweep();
    }
  }, 60_000).unref();
}

rootLogger.info({ port: server.port }, "Infoserver started");
