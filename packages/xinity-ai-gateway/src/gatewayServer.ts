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
import { handleCreateResponseRequest, handleGetOrDeleteResponseRequest, handleCancelResponseRequest } from "./llm-forward/endpoints/handle-responses";
import { handleRerank } from "./llm-forward/endpoints/handle-rerank";
import { handleTranscription } from "./llm-forward/endpoints/handle-transcription";
import { handleMetrics, withMetrics } from "./metrics";
import { getTlsConfig } from "common-env";
import { logMigrationFailureFatal } from "common-db";
import { getSearchProvider } from "./llm-forward/tools/search-providers";
import { setSearchProvider } from "./llm-forward/tools/response-tools";
import { flushUsageEvents } from "./usageRecorder";
import { flushApiCallRows } from "./callLogger";

process.on("unhandledRejection", (reason) => {
  rootLogger.error({ err: reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  rootLogger.error({ err }, "Uncaught exception");
});

const migrationState = await checkMigrations();
if (migrationState.status !== "ok") {
  logMigrationFailureFatal(migrationState, rootLogger, "gateway");
  process.exit(1);
}

const handler = new OpenAPIHandler(serverRouter, {
  plugins: [],
});

const tls = getTlsConfig(env);
setSearchProvider(getSearchProvider(env));

const meteredEndpoints: Array<[string, (req: Request) => Promise<Response> | Response]> = [
  ["/v1/chat/completions", handleChatCompletion],
  ["/v1/completions", handleCompletion],
  ["/v1/embeddings", handleEmbeddingGeneration],
  ["/v1/audio/transcriptions", handleTranscription],
  ["/v1/models", handleModelsRequest],
  ["/v1/rerank", handleRerank],
  ["/v1/responses", handleCreateResponseRequest],
  ["/v1/responses/:responseId", handleGetOrDeleteResponseRequest],
  ["/v1/responses/:responseId/cancel", handleCancelResponseRequest],
];

const meteredRoutes = Object.fromEntries(
  meteredEndpoints.map(([path, handler]) => [path, withMetrics(path, handler)]),
);

const serveOptions = {
  tls,
  routes: {
    "/docs": createScalarPage(),
    "/openapi.json": await createOpenapiSpec(),
    "/metrics": handleMetrics,
    ...meteredRoutes,
  },
  fetch: handleRequest,
  idleTimeout: env.IDLE_TIMEOUT,
} as const;

const proto = tls ? "https" : "http";
const serveTarget = env.UNIX_SOCKET
  ? { unix: env.UNIX_SOCKET, idleTimeout: undefined }
  : { port: env.PORT, hostname: env.HOST };
const server = Bun.serve({ ...serveOptions, ...serveTarget });
rootLogger.info({ ...serveTarget, tls: !!tls }, `Gateway started (${proto})`);

let isShuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  rootLogger.info({ signal }, "Gateway shutting down, flushing write queues...");
  server.stop(true);
  try {
    await Promise.all([flushUsageEvents(), flushApiCallRows()]);
    rootLogger.info("Write queues flushed successfully");
  } catch (err) {
    rootLogger.error({ err }, "Error flushing write queues on shutdown");
  }
  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

async function handleRequest(req: Request): Promise<Response> {
  const { matched, response } = await handler.handle(req, {
    prefix: "/",
    context: { headers: req.headers },
  });

  if (matched) {
    return response;
  }
  return errorResponse("Not found", 404);
}
