import { createLegacyModelJsonSchema, createModelJsonSchema } from "./definitions/model-definition";
import { version } from "../../package.json";
import { env } from "./env";
import { rootLogger } from "./logger";
import * as catalog from "./server-catalog";
import { legacyCatalog, modelCatalog } from "./server-catalog";
import { handleModelList, handleModelsByFamily, handleModelBySpecifier, handleBatchResolve } from "./api-handlers.legacy";
import { matchesEtag } from "./http-cache";
import { resolveClientIp } from "./client-ip";
import { createRateLimiter, withRateLimit, type RateLimiter, type RouteHandler } from "./rate-limit";
import type { SerializedCatalog } from "./catalog";

const port = env.PORT;

catalog.configure(env.MAX_INCLUDE_DEPTH, env.MODEL_INFO_DIR, env.MODEL_LEGACY_DIR);

// The refresh above is the validation: it throws on anything this server could not
// serve. `--check` is how CI asks that question without leaving a server running.
await catalog.refresh();
if (Bun.argv.includes("--check")) {
  process.exit(0);
}

catalog.startAutoRefresh(env.REFRESH_INTERVAL_MS);

const CACHE_CONTROL = `public, max-age=${Math.floor(env.REFRESH_INTERVAL_MS / 1000)}`;

/** No Sunset header: RFC 8594 wants a date, and the removal is pinned to a version. */
const DEPRECATION_HEADERS: Record<string, string> = {
  Deprecation: "true",
  Link: '<https://github.com/xinity-ai/xinity-ai/blob/main/packages/xinity-infoserver/README.md#model-format-versions>; rel="deprecation"',
};

const exportLimiter = createRateLimiter({ perMinute: env.RATE_LIMIT_EXPORT_PER_MINUTE });
const apiLimiter = createRateLimiter({ perMinute: env.RATE_LIMIT_API_PER_MINUTE });

const clientIpConfig = { header: env.HTTP_IP_HEADER, xffDepth: env.HTTP_XFF_DEPTH };

function limited(limiter: RateLimiter, handler: RouteHandler): RouteHandler {
  if (!env.RATE_LIMIT_ENABLED) {
    return handler;
  }
  return withRateLimit(
    limiter,
    (req, server) => resolveClientIp(req, server, clientIpConfig),
    handler,
  );
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

/** Aggregate mirrors the pre-split shape so existing monitoring keeps working. */
function healthBody() {
  const health = catalog.getCatalogHealth();
  const modelCount = health.models.modelCount + health.legacy.modelCount;
  const lastRefreshError = health.models.lastRefreshError ?? health.legacy.lastRefreshError;

  return {
    ok: modelCount > 0 && lastRefreshError === null,
    catalog: {
      modelCount,
      lastRefreshAt: health.models.lastRefreshAt ?? health.legacy.lastRefreshAt,
      lastRefreshError,
    },
    models: health.models,
    legacy: health.legacy,
  };
}

const server = Bun.serve({
  port,
  routes: {
    "/health": () => Response.json(healthBody()),
    "/version.json": Response.json({ version }),
    "/schemas/model.v2.json": Response.json(createModelJsonSchema()),

    "/models/v2.json": limited(exportLimiter, serveCatalogBody(modelCatalog, s => s.json, "application/json; charset=utf-8")),
    // Exists so polling for change is cheap enough to leave on a loose ceiling,
    // which a conditional GET of the catalog itself cannot be: it shares a URL
    // with the full fetch, so the two cannot be limited apart.
    "/models/v2.digest.json": limited(apiLimiter, () => Response.json(
      { digest: modelCatalog.getSerializedCatalog().digest },
      { headers: { "Cache-Control": CACHE_CONTROL } },
    )),

    // Deprecated v1 surface, removed before 1.0.0. Serves MODEL_LEGACY_DIR only.
    "/models/v1.yaml": legacyRoute(limited(exportLimiter, serveCatalogBody(legacyCatalog, s => s.yaml, "application/yaml"))),
    "/models/v1.json": legacyRoute(limited(exportLimiter, serveCatalogBody(legacyCatalog, s => s.json, "application/json; charset=utf-8"))),
    "/schemas/model.v1.json": new Response(JSON.stringify(createLegacyModelJsonSchema()), {
      headers: { "Content-Type": "application/json; charset=utf-8", ...DEPRECATION_HEADERS },
    }),
    "/api/v1/models": legacyRoute(limited(apiLimiter, handleModelList)),
    "/api/v1/models/resolve": legacyRoute(limited(apiLimiter, handleBatchResolve)),
    "/api/v1/models/family/:family": legacyRoute(limited(apiLimiter, handleModelsByFamily)),
    "/api/v1/models/:specifier": legacyRoute(limited(apiLimiter, handleModelBySpecifier)),
  },
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
});

if (env.RATE_LIMIT_ENABLED) {
  setInterval(() => {
    exportLimiter.sweep();
    apiLimiter.sweep();
  }, 60_000).unref();
}

rootLogger.info({ port: server.port }, "Infoserver started");
