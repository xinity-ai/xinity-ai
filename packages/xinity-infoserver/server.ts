import { createModelJsonSchema } from "./definitions/model-definition";
import { version } from "../../package.json";
import { env } from "./env";
import { rootLogger } from "./logger";
import * as catalog from "./server-catalog";
import { handleModelList, handleModelsByFamily, handleModelBySpecifier, handleBatchResolve } from "./api-handlers";

const modelFile = env.MODEL_INFO_FILE;
const modelDir = env.MODEL_INFO_DIR;
const port = env.PORT;

if (!modelFile && !modelDir) {
  throw new Error("At least one of MODEL_INFO_FILE or MODEL_INFO_DIR must be set");
}

catalog.configure(env.MAX_INCLUDE_DEPTH, modelFile, modelDir);
await catalog.refresh();
catalog.startAutoRefresh(env.REFRESH_INTERVAL_MS);

const server = Bun.serve({
  port,
  routes: {
    "/health": Response.json({ ok: true }),
    "/version.json": Response.json({ version }),
    "/models/v1.yaml": () => new Response(Bun.YAML.stringify(catalog.getMergedData()), {
      headers: { "Content-Type": "application/yaml" },
    }),
    "/models/v1.json": () => Response.json(catalog.getMergedData()),
    "/schemas/model.v1.json": Response.json(createModelJsonSchema()),

    // Programmatic API
    "/api/v1/models": (req) => handleModelList(req),
    "/api/v1/models/resolve": (req) => handleBatchResolve(req),
    "/api/v1/models/family/:family": (req) => handleModelsByFamily(req),
    "/api/v1/models/:specifier": (req) => handleModelBySpecifier(req),
  },
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
});

rootLogger.info({ port: server.port }, "Infoserver started");
