import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { serverRouter } from "./rpc/gatewayRouter";
import { env } from "./env";
import { checkMigrations } from "./db";
import { rootLogger } from "./logger";
import { createOpenapiSpec, createScalarPage } from "./openapi";
import { handleChatCompletion } from "./llm-forward/endpoints/handle-chatCompletion";
import { handleCompletion } from "./llm-forward/endpoints/handle-completions";
import { errorResponse } from "./llm-forward/util";
import { handleEmbeddingGeneration } from "./llm-forward/endpoints/handle-embeddings";
import { handleModelsRequest } from "./llm-forward/endpoints/handle-models";
import { handleCreateResponseRequest, handleGetOrDeleteResponseRequest } from "./llm-forward/endpoints/handle-responses";
import { handleRerank } from "./llm-forward/endpoints/handle-rerank";
import { handleMetrics, withMetrics } from "./metrics";
import { getTlsConfig } from "common-env";

process.on("unhandledRejection", (reason) => {
  rootLogger.error({ err: reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  rootLogger.error({ err }, "Uncaught exception");
});

const migrationState = await checkMigrations();
if (migrationState.status !== "ok") {
  rootLogger.fatal("Database migrations are not up to date, gateway cannot start.");
  if (migrationState.status === "pending") {
    rootLogger.fatal(`${migrationState.applied} of ${migrationState.expected} migrations applied, ${migrationState.expected - migrationState.applied} pending.`);
  } else if (migrationState.status === "no_table") {
    rootLogger.fatal("Migrations table not found, database not initialized.");
  } else {
    rootLogger.fatal(migrationState.message);
  }
  rootLogger.fatal('Run "xinity up db" or "cd packages/common-db && bun run migrate" to apply migrations.');
  process.exit(1);
}

const handler = new OpenAPIHandler(serverRouter, {
  plugins: [],
});

const tls = getTlsConfig(env);

const serveOptions = {
  tls,
  routes: {
    "/docs": createScalarPage(),
    "/openapi.json": await createOpenapiSpec(),
    "/metrics": handleMetrics,
    "/v1/chat/completions": withMetrics("/v1/chat/completions", handleChatCompletion),
    "/v1/completions": withMetrics("/v1/completions", handleCompletion),
    "/v1/embeddings": withMetrics("/v1/embeddings", handleEmbeddingGeneration),
    "/v1/models": withMetrics("/v1/models", handleModelsRequest),
    "/v1/rerank": withMetrics("/v1/rerank", handleRerank),
    "/v1/responses": withMetrics("/v1/responses", handleCreateResponseRequest),
    "/v1/responses/:responseId": withMetrics("/v1/responses/:responseId", handleGetOrDeleteResponseRequest),
  },
  fetch: handleRequest,
  idleTimeout: env.IDLE_TIMEOUT,
} as const;

const proto = tls ? "https" : "http";
if (env.UNIX_SOCKET) {
  Bun.serve({ ...serveOptions, unix: env.UNIX_SOCKET, idleTimeout: undefined });
  rootLogger.info({ unix: env.UNIX_SOCKET, tls: !!tls }, `Gateway started (${proto})`);
} else {
  Bun.serve({ ...serveOptions, port: env.PORT, hostname: env.HOST });
  rootLogger.info({ host: env.HOST, port: env.PORT, tls: !!tls }, `Gateway started (${proto})`);
}

async function handleRequest(req: Request): Promise<Response> {
  const { matched, response } = await handler.handle(req, {
    prefix: "/",
    context: { headers: req.headers }, // Provide initial context if needed
  });

  if (matched) {
    return response;
  }
  return errorResponse("Not found", 404);
}
