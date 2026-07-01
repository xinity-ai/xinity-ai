import { z } from "zod";
import { errorResponse, forwardBackendError } from "../util";
import { withEndpointGuards } from "../endpoint-guards";
import { rootLogger } from "../../logger";
import { env } from "../../env";
import { backendPostJson } from "../backend-fetch";

const log = rootLogger.child({ name: "handle-rerank" });

export const RerankBodySchema = z.looseObject({
  model: z.string(),
  query: z.string(),
  documents: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])),
  top_n: z.number().optional(),
  return_documents: z.boolean().optional().default(true),
});

export const handleRerank = withEndpointGuards({
  modelTypes: ["rerank"],
  bodySchema: RerankBodySchema,
  log,
  handler: async ({ body, modelInfo, originalModel, req }) => {
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(env.BACKEND_TIMEOUT_MS)]);
    const backendResponse = await backendPostJson(modelInfo, "/v1/rerank", {
      model: modelInfo.model,
      query: body.query,
      documents: body.documents,
      top_n: body.top_n,
      return_documents: body.return_documents,
    }, signal);

    if (!backendResponse.ok) {
      return forwardBackendError(backendResponse, log, modelInfo.model);
    }

    let result: Record<string, unknown>;
    try {
      result = await backendResponse.json() as Record<string, unknown>;
    } catch {
      return errorResponse("Backend returned an invalid response", 502);
    }

    return Response.json({
      ...result,
      model: originalModel,
    });
  },
});
