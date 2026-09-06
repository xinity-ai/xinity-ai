import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { getTlsConfig } from "common-env";
import { router } from "../../rpc/router";
import { env } from "../../env";
import { rootLogger } from "../../logger";
import { createOpenapiSpec, createScalarPage } from "./openai";
import { handleProxyRequest } from "./proxy";
import { handleDaemonMetrics, httpMetrics } from "./metrics";

export async function startServer() {
  const handler = new OpenAPIHandler(router, {
    plugins: [],
  });

  const spec = await createOpenapiSpec();

  const tls = getTlsConfig(env);
  const serveOptions = {
    tls,
    idleTimeout: env.IDLE_TIMEOUT,
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
  const serveTarget = env.UNIX_SOCKET
    ? { unix: env.UNIX_SOCKET, idleTimeout: undefined }
    : { port: env.PORT, hostname: env.HOST };
  Bun.serve({ ...serveOptions, ...serveTarget });
  rootLogger.info({ ...serveTarget, tls: !!tls }, `Daemon server started (${proto})`);
}
