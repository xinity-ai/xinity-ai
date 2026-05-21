import { z } from "zod";
import { forwardBackendError } from "../util";
import { withEndpointGuards } from "../endpoint-guards";
import { rootLogger } from "../../logger";
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
    const backendResponse = await backendPostJson(modelInfo, "/v1/rerank", {
      model: modelInfo.model,
      query: body.query,
      documents: body.documents,
      top_n: body.top_n,
      return_documents: body.return_documents,
    }, req.signal);

    if (!backendResponse.ok) {
      return forwardBackendError(backendResponse, log);
    }

    const result = await backendResponse.json() as Record<string, unknown>;

    return Response.json({
      ...result,
      model: originalModel,
    });
  },
});
