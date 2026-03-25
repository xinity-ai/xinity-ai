import { z } from "zod";
import { resolveModel } from "../ai-sdk";
import { errorResponse, forwardBackendError, logChatUsage, readSSEStream, validateModelType } from "../util";
import { BackendCompletionChunkSchema, BackendUsageSchema } from "../backend-schemas";
import type { ApiCallInputMessage } from "common-db";
import { rootLogger } from "../../logger";
import { env } from "../../env";

const log = rootLogger.child({ name: "handle-completions" });

const encoder = new TextEncoder();

const CompletionBodySchema = z.looseObject({
  model: z.string(),
  prompt: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  stream: z.boolean().optional().default(false),
  seed: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  store: z.boolean().optional().default(true),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const normalizePrompt = (prompt: string | string[] | undefined): string | null => {
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) return prompt.join("\n");
  return null;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleCompletion(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") {
      return errorResponse("Method not allowed", 405);
    }

    const resolved = await resolveModel(req);
    if (resolved instanceof Response) return resolved;

    const { auth, body: rawBody, originalModel, modelInfo } = resolved;

    const typeError = validateModelType(modelInfo, ["chat"]);
    if (typeError) return typeError;

    const parseResult = CompletionBodySchema.safeParse(rawBody);
    if (!parseResult.success) {
      return errorResponse(`Invalid request body: ${parseResult.error.issues.map((i) => i.message).join(", ")}`, 400);
    }
    const body = parseResult.data;

    const promptText = normalizePrompt(body.prompt);
    if (!promptText) {
      return errorResponse("Unsupported data type", 422);
    }

    const callStartTime = Date.now();

    const inputMessages: ApiCallInputMessage[] = [{ role: "user", content: promptText }];
    const logFields = {
      auth,
      modelInfo,
      modelSpecifier: originalModel,
      inputMessages,
      callStartTime,
      logCalls: body.store,
      metadata: body.metadata ?? undefined,
    } as const;

    const fetchBody: Record<string, unknown> = {
      model: modelInfo.model,
      prompt: promptText,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      frequency_penalty: body.frequency_penalty,
      presence_penalty: body.presence_penalty,
      seed: body.seed,
      stop: body.stop,
      stream: body.stream,
    };
    if (body.stream) fetchBody.stream_options = { include_usage: true };

    const backendResponse = await fetch(`http://${modelInfo.host}/v1/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fetchBody),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(env.BACKEND_TIMEOUT_MS)]),
    });

    if (!backendResponse.ok) {
      return forwardBackendError(backendResponse, log);
    }

    if (body.stream) {
      const streamDeltas: z.infer<typeof BackendCompletionChunkSchema>[] = [];
      let collectedUsage: z.infer<typeof BackendUsageSchema> | undefined = undefined;

      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const event of readSSEStream(backendResponse)) {
              if (event.data === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                break;
              }

              let json: unknown;
              try { json = JSON.parse(event.data); } catch {
                log.warn({ data: event.data }, "Non-JSON SSE chunk from backend, skipping");
                continue;
              }
              const parsed = BackendCompletionChunkSchema.safeParse(json);
              if (!parsed.success) {
                log.warn({ issues: parsed.error.issues }, "Malformed backend SSE chunk, skipping");
                continue;
              }
              const chunk = { ...parsed.data, model: originalModel };

              if (chunk.usage) collectedUsage = chunk.usage;
              if (chunk.choices.length) streamDeltas.push(chunk);

              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.close();

            // Translate completions format (choices[].text) to chat delta format for logging
            logChatUsage({
              ...logFields,
              usage: collectedUsage,
              outputData: streamDeltas.map((c) => ({
                model: c.model,
                choices: c.choices.map((ch) => ({
                  index: ch.index,
                  delta: { role: "assistant" as const, content: ch.text },
                  finish_reason: ch.finish_reason ?? null,
                })),
              })),
              stream: true,
            });
          } catch (e) {
            log.error({ err: e }, "Stream error");
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: "Internal stream error", type: "server_error" } })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Non-streaming: always forward, extract logging data field-by-field
    let raw: Record<string, unknown>;
    try {
      raw = await backendResponse.json() as Record<string, unknown>;
    } catch {
      return errorResponse("Backend returned an invalid response", 502);
    }

    raw.model = originalModel;

    const choicesResult = z.array(z.looseObject({
      index: z.number(),
      text: z.string(),
      finish_reason: z.string().nullable().optional(),
    })).safeParse(raw.choices);

    const usageResult = BackendUsageSchema.safeParse(raw.usage);

    if (choicesResult.success) {
      logChatUsage({
        ...logFields,
        usage: usageResult.success ? usageResult.data : undefined,
        outputData: {
          model: originalModel,
          choices: choicesResult.data.map((ch) => ({
            index: ch.index,
            message: { role: "assistant", content: ch.text },
          })),
        },
        stream: false,
      });
    } else {
      log.warn({ issues: choicesResult.error.issues }, "Could not extract choices for logging");
    }

    return Response.json(raw);
  } catch (error) {
    log.error({ err: error }, "Internal gateway error");
    return errorResponse(error instanceof Error ? error.message : "Internal Server Error", 500);
  }
}
