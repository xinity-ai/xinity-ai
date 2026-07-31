import { createModelJsonSchema } from "./definitions/model-definition";
import { version } from "../../package.json";
import { env } from "./env";
import { rootLogger } from "./logger";
import * as catalog from "./server-catalog";
import { handleModelList, handleModelsByFamily, handleModelBySpecifier, handleBatchResolve } from "./api-handlers";
import { matchesEtag } from "./http-cache";
import { resolveClientIp } from "./client-ip";
import { createRateLimiter, withRateLimit, type RateLimiter, type RouteHandler } from "./rate-limit";

const port = env.PORT;

catalog.configure(env.MAX_INCLUDE_DEPTH, env.MODEL_INFO_DIR);
await catalog.refresh();
catalog.startAutoRefresh(env.REFRESH_INTERVAL_MS);

const CACHE_CONTROL = `public, max-age=${Math.floor(env.REFRESH_INTERVAL_MS / 1000)}`;

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

function serveCatalogBody(
  pick: (serialized: catalog.SerializedCatalog) => string,
  contentType: string,
): RouteHandler {
  return (req) => {
    const serialized = catalog.getSerializedCatalog();
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

const server = Bun.serve({
  port,
  routes: {
    "/health": () => {
      const health = catalog.getCatalogHealth();
      return Response.json({ ok: health.modelCount > 0, catalog: health });
    },
    "/version.json": Response.json({ version }),
    "/models/v1.yaml": limited(exportLimiter, serveCatalogBody(s => s.yaml, "application/yaml")),
    "/models/v1.json": limited(exportLimiter, serveCatalogBody(s => s.json, "application/json; charset=utf-8")),
    "/schemas/model.v1.json": Response.json(createModelJsonSchema()),

    // Programmatic API
    "/api/v1/models": limited(apiLimiter, handleModelList),
    "/api/v1/models/resolve": limited(apiLimiter, handleBatchResolve),
    "/api/v1/models/family/:family": limited(apiLimiter, handleModelsByFamily),
    "/api/v1/models/:specifier": limited(apiLimiter, handleModelBySpecifier),
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
