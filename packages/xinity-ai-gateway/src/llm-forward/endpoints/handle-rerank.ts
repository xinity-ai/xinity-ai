import { z } from "zod";
import { resolveModel } from "../ai-sdk";
import { errorResponse, forwardBackendError, validateModelType } from "../util";
import { rootLogger } from "../../logger";
import { env } from "../../env";

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
      return errorResponse(`Invalid request body: ${parseResult.error.issues.map((i) => i.message).join(", ")}`, 400);
    }
    const body = parseResult.data;

    const backendResponse = await fetch(`http://${modelInfo.host}/v1/rerank`, {
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
    });

    if (!backendResponse.ok) {
      return forwardBackendError(backendResponse, log);
    }

    const result: any = await backendResponse.json();

    return Response.json({
      ...result,
      model: originalModel,
    });
  } catch (error) {
    log.error({ err: error }, "Internal gateway error");
    return errorResponse(error instanceof Error ? error.message : "Internal Server Error", 500);
  }
}
