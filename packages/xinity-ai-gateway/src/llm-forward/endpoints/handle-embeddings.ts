import { z } from "zod";
import { resolveModel } from "../ai-sdk";
import { errorResponse, forwardBackendError, recordUsage, validateModelType } from "../util";
import { rootLogger } from "../../logger";
import { env } from "../../env";

const log = rootLogger.child({ name: "handle-embeddings" });

const EmbeddingBodySchema = z.looseObject({
  model: z.string(),
  input: z.union([z.string(), z.array(z.string())]),
  encoding_format: z.enum(["float", "base64"]).optional().default("float"),
  dimensions: z.number().optional(),
  user: z.string().optional(),
});

export async function handleEmbeddingGeneration(req: Request): Promise<Response> {
  try {
    const resolved = await resolveModel(req);
    if (resolved instanceof Response) return resolved;

    const { auth, body: rawBody, modelInfo, originalModel } = resolved;

    const typeError = validateModelType(modelInfo, ["embedding"]);
    if (typeError) return typeError;

    const parseResult = EmbeddingBodySchema.safeParse(rawBody);
    if (!parseResult.success) {
      return errorResponse(`Invalid request body: ${parseResult.error.issues.map((i) => i.message).join(", ")}`, 400);
    }
    const body = parseResult.data;

    const callStartTime = Date.now();

    const fetchBody: Record<string, unknown> = {
      model: modelInfo.model,
      input: body.input,
      encoding_format: body.encoding_format,
    };
    if (body.dimensions != null) fetchBody.dimensions = body.dimensions;
    if (body.user != null) fetchBody.user = body.user;

    const backendResponse = await fetch(`http://${modelInfo.host}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fetchBody),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(env.BACKEND_TIMEOUT_MS)]),
    });

    if (!backendResponse.ok) {
      return forwardBackendError(backendResponse, log);
    }

    // Always forward, extract usage best-effort
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
  } catch (error) {
    log.error({ err: error }, "Internal gateway error");
    return errorResponse(error instanceof Error ? error.message : "Internal Server Error", 500);
  }
}
