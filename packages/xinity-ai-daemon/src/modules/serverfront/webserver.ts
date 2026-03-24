import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { router } from "../../rpc/router";
import { env } from "../../env";
import { rootLogger } from "../../logger";
import { createOpenapiSpec, createScalarPage } from "./openai";

export async function startServer() {
  const handler = new OpenAPIHandler(router, {
    plugins: [],
  });

  createServer(handleRequest).listen(env.PORT, env.HOST, () =>
    rootLogger.info({ host: env.HOST, port: env.PORT }, "Daemon server started")
  );

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>
  ) {
    const { matched } = await handler.handle(req, res, {
      prefix: "/",
      context: { headers: req.headers }, // Provide initial context if needed
    });

    if (matched) {
      return;
    }

    if (req.url === "/") {
      return createScalarPage(res);
    }
    if (req.url === "/openapi.json") {
      const spec = await createOpenapiSpec();
      res.setHeader("content-type", "application/json");

      res.statusCode = 200;
      res.end(JSON.stringify(spec));
      return;
    }

    res.statusCode = 404;
    res.end("Not found");
  }
}
