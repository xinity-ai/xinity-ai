import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { router } from "../../rpc/router";
import { env } from "../../env";
import { rootLogger } from "../../logger";
import { createOpenapiSpec, createScalarPage } from "./openai";

export async function startServer() {
  const handler = new OpenAPIHandler(router, {
    plugins: [],
  });

  const spec = await createOpenapiSpec();

  const serveOptions = {
    idleTimeout: env.IDLE_TIMEOUT,
    routes: {
      "/": () => createScalarPage(),
      "/openapi.json": () => Response.json(spec),
    },
    async fetch(req: Request) {
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

  if (env.UNIX_SOCKET) {
    Bun.serve({ ...serveOptions, unix: env.UNIX_SOCKET });
    rootLogger.info({ unix: env.UNIX_SOCKET }, "Daemon server started");
  } else {
    Bun.serve({ ...serveOptions, port: env.PORT, hostname: env.HOST });
    rootLogger.info({ host: env.HOST, port: env.PORT }, "Daemon server started");
  }
}
