import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { getTlsConfig } from "common-env";
import { router } from "../../rpc/router";
import { env } from "../../env";
import { rootLogger } from "../../logger";
import { createOpenapiSpec, createScalarPage } from "./openai";
import { handleProxyRequest } from "./proxy";

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
      "/": () => createScalarPage(),
      "/openapi.json": () => Response.json(spec),
    },
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/proxy/")) {
        return handleProxyRequest(req, url);
      }

      const { matched, response } = await handler.handle(req, {
        prefix: "/",
        context: { headers: req.headers },
      });

      if (matched) {
        return response;
      }

      return new Response("Not found", { status: 404 });
    },
  } as const;

  const proto = tls ? "https" : "http";
  if (env.UNIX_SOCKET) {
    Bun.serve({ ...serveOptions, unix: env.UNIX_SOCKET });
    rootLogger.info({ unix: env.UNIX_SOCKET, tls: !!tls }, `Daemon server started (${proto})`);
  } else {
    Bun.serve({ ...serveOptions, port: env.PORT, hostname: env.HOST });
    rootLogger.info({ host: env.HOST, port: env.PORT, tls: !!tls }, `Daemon server started (${proto})`);
  }
}
