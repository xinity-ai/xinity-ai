import { z } from "zod";
import { resolveModel } from "../ai-sdk";
import { forwardBackendError, validateModelType, handleEndpointError, validationError } from "../util";
import { rootLogger } from "../../logger";
import { env } from "../../env";
import { backendFetch, backendUrl } from "../backend-fetch";

const log = rootLogger.child({ name: "handle-rerank" });

// ---------------------------------------------------------------------------
// Request body schema
// ---------------------------------------------------------------------------

const RerankBodySchema = z.looseObject({
  model: z.string(),
  query: z.string(),
  documents: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])),
  top_n: z.number().optional(),
  return_documents: z.boolean().optional().default(true),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleRerank(req: Request): Promise<Response> {
  try {
    const resolved = await resolveModel(req);
    if (resolved instanceof Response) {
      return resolved;
    }

    const { body: rawBody, modelInfo, originalModel } = resolved;

    const typeError = validateModelType(modelInfo, ["rerank"]);
    if (typeError) return typeError;

    const parseResult = RerankBodySchema.safeParse(rawBody);
    if (!parseResult.success) {
      return validationError(parseResult.error);
    }
    const body = parseResult.data;

    const backendResponse = await backendFetch(backendUrl(modelInfo.host, modelInfo.model, "/v1/rerank", modelInfo.tls), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelInfo.model,
        query: body.query,
        documents: body.documents,
        top_n: body.top_n,
        return_documents: body.return_documents,
      }),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(env.BACKEND_TIMEOUT_MS)]),
      authToken: modelInfo.authToken ?? undefined,
    });

    if (!backendResponse.ok) {
      return forwardBackendError(backendResponse, log);
    }

    const result = await backendResponse.json() as Record<string, unknown>;

    return Response.json({
      ...result,
      model: originalModel,
    });
  } catch (error) {
    return handleEndpointError(error, log);
  }
}
