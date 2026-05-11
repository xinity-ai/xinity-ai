import { z } from "zod";
import { errorResponse, forwardBackendError, recordUsage } from "../util";
import { withEndpointGuards } from "../endpoint-guards";
import { rootLogger } from "../../logger";
import { env } from "../../env";
import { backendFetch, backendUrl } from "../backend-fetch";

const log = rootLogger.child({ name: "handle-embeddings" });

export const EmbeddingBodySchema = z.looseObject({
  model: z.string(),
  input: z.union([z.string(), z.array(z.string())]),
  encoding_format: z.enum(["float", "base64"]).optional().default("float"),
  dimensions: z.number().optional(),
  user: z.string().optional(),
});

export const handleEmbeddingGeneration = withEndpointGuards({
  modelTypes: ["embedding"],
  bodySchema: EmbeddingBodySchema,
  log,
  handler: async ({ auth, body, modelInfo, originalModel, req }) => {
    const callStartTime = Date.now();

    const fetchBody: Record<string, unknown> = {
      model: modelInfo.model,
      input: body.input,
      encoding_format: body.encoding_format,
    };
    if (body.dimensions != null) {
      fetchBody.dimensions = body.dimensions;
    }
    if (body.user != null) {
      fetchBody.user = body.user;
    }

    const backendResponse = await backendFetch(backendUrl(modelInfo.host, modelInfo.model, "/v1/embeddings", modelInfo.tls), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fetchBody),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(env.BACKEND_TIMEOUT_MS)]),
      authToken: modelInfo.authToken ?? undefined,
    });

    if (!backendResponse.ok) {
      return forwardBackendError(backendResponse, log);
    }

    let raw: Record<string, unknown>;
    try {
      raw = await backendResponse.json() as Record<string, unknown>;
    } catch {
      return errorResponse("Backend returned an invalid response", 502);
    }

    raw.model = originalModel;

    const usageResult = z.looseObject({
      prompt_tokens: z.number(),
      total_tokens: z.number(),
    }).safeParse(raw.usage);

    if (usageResult.success) {
      recordUsage({
        usage: { prompt_tokens: usageResult.data.prompt_tokens, completion_tokens: 0 },
        auth,
        modelInfo,
        callStartTime,
        logCalls: false,
      });
    } else {
      log.warn({ issues: usageResult.error?.issues }, "Could not extract usage for embeddings");
    }

    return Response.json(raw);
  },
});
