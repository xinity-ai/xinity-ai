import { OpenAPIHandler } from "@orpc/openapi/fetch";

import { router } from "../../rpc/router";
import { config } from "../../config";
import { rootLogger } from "../../logger";
import { createOpenapiSpec, createScalarPage } from "./openai";
import { handleProxyRequest } from "./proxy";
import { handleDaemonMetrics, httpMetrics } from "./metrics";

export async function startServer() {
  const handler = new OpenAPIHandler(router, {
    plugins: [],
  });

  const spec = await createOpenapiSpec();

  const tls = config.tls && { cert: config.tls.cert, key: config.tls.key };
  const serveOptions = {
    tls,
    idleTimeout: config.server.idleTimeout,
    routes: {
      "/": httpMetrics.route("/", () => createScalarPage()),
      "/openapi.json": httpMetrics.route("/openapi.json", () => Response.json(spec)),
    },
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname === "/metrics") {
        return handleDaemonMetrics(req);
      }
      // The proxy path carries a model name, so it is labelled by pattern.
      if (url.pathname.startsWith("/proxy/")) {
        return httpMetrics.route("/proxy/*", (r) => handleProxyRequest(r, url))(req);
      }

      return httpMetrics.route("/rpc", async (r) => {
        const { matched, response } = await handler.handle(r, {
          prefix: "/",
          context: { headers: r.headers },
        });
        return matched ? response : new Response("Not found", { status: 404 });
      })(req);
    },
  } as const;

  const proto = tls ? "https" : "http";
  const serveTarget = config.server.unixSocket
    ? { unix: config.server.unixSocket, idleTimeout: undefined }
    : { port: config.server.port, hostname: config.server.host };
  Bun.serve({ ...serveOptions, ...serveTarget });
  rootLogger.info({ ...serveTarget, tls: !!tls }, `Daemon server started (${proto})`);
}
