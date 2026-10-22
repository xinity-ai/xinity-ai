import { z } from "zod";
import { errorResponse, forwardBackendError, recordUsage } from "../util";
import { withEndpointGuards } from "../endpoint-guards";
import { rootLogger } from "../../logger";
import { config } from "../../config";
import { backendPostJson } from "../backend-fetch";

const log = rootLogger.child({ name: "handle-rerank" });

export const RerankBodySchema = z.looseObject({
  model: z.string(),
  query: z.string(),
  documents: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])),
  top_n: z.number().optional(),
  return_documents: z.boolean().optional().default(true),
});

const RerankUsageSchema = z.looseObject({
  prompt_tokens: z.number().optional(),
  total_tokens: z.number(),
});

export const handleRerank = withEndpointGuards({
  modelTypes: ["rerank"],
  bodySchema: RerankBodySchema,
  log,
  handler: async ({ auth, body, modelInfo, originalModel, req }) => {
    const callStartTime = Date.now();
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(config.inference.backendTimeoutMs())]);
    const backendResponse = await backendPostJson(modelInfo, "/v1/rerank", {
      model: modelInfo.model,
      query: body.query,
      documents: body.documents,
      top_n: body.top_n,
      return_documents: body.return_documents,
    }, signal);

    if (!backendResponse.ok) {
      return forwardBackendError(backendResponse, log, modelInfo);
    }

    let result: Record<string, unknown>;
    try {
      result = await backendResponse.json() as Record<string, unknown>;
    } catch {
      return errorResponse("Backend returned an invalid response", 502);
    }

    const usageResult = RerankUsageSchema.safeParse(result.usage);
    if (!usageResult.success) {
      log.warn({ issues: usageResult.error.issues }, "Could not extract usage for rerank");
    }
    recordUsage({
      usage: usageResult.success
        ? { prompt_tokens: usageResult.data.prompt_tokens ?? usageResult.data.total_tokens, completion_tokens: 0 }
        : undefined,
      auth,
      modelInfo,
      callStartTime,
      logCalls: false,
    });

    return Response.json({
      ...result,
      model: originalModel,
    });
  },
});
