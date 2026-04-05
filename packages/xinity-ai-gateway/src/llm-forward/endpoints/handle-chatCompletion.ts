import { z } from "zod";
import { errorResponse, forwardBackendError, logChatUsage, validateModelType, extractAllowedRequestParams, readSSEStream, handleEndpointError, SSE_RESPONSE_HEADERS, sseEncoder, handleStreamError } from "../util";
import { resolveModel } from "../ai-sdk";
import { BackendChatChunkSchema, BackendUsageSchema } from "../backend-schemas";
import type { ApiCallInputMessage } from "common-db";
import { rootLogger } from "../../logger";
import { processMessageImages, imageStore } from "../../image-store";
import { env } from "../../env";

const log = rootLogger.child({ name: "handle-chatCompletion" });

const ChatCompletionBodySchema = z.looseObject({
  model: z.string(),
  messages: z.array(z.looseObject({
    role: z.string(),
    content: z.unknown(),
  })),
  stream: z.boolean().optional().default(false),
  store: z.boolean().optional().default(true),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  top_p: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  seed: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  response_format: z.object({
    type: z.enum(["text", "json_object", "json_schema"]),
    json_schema: z.object({
      name: z.string().optional(),
      schema: z.unknown().optional(),
    }).optional(),
  }).optional(),
  structured_outputs: z.record(z.string(), z.json().optional()).optional(),
  tools: z.array(z.looseObject({
    type: z.literal("function"),
    function: z.looseObject({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
      strict: z.boolean().optional(),
    }),
  })).optional(),
  tool_choice: z.union([
    z.enum(["auto", "none", "required"]),
    z.looseObject({
      type: z.literal("function"),
      function: z.looseObject({ name: z.string() }),
    }),
  ]).optional(),
});

export async function handleChatCompletion(req: Request) {
  try {
    const resolved = await resolveModel(req);
    if (resolved instanceof Response) return resolved;

    const { auth, body: rawBody, originalModel, modelInfo } = resolved;

    const typeError = validateModelType(modelInfo, ["chat"]);
    if (typeError) return typeError;

    const parseResult = ChatCompletionBodySchema.safeParse(rawBody);
    if (!parseResult.success) {
      return errorResponse(`Invalid request body: ${parseResult.error.issues.map((i) => i.message).join(", ")}`, 400);
    }
    const body = parseResult.data;

    // Reject structured_outputs for non-vLLM drivers
    if (body.structured_outputs && modelInfo.driver !== "vllm") {
      return errorResponse("structured_outputs is only supported with the vLLM driver", 400);
    }

    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (hasTools && !modelInfo.tags.includes("tools")) {
      return errorResponse("Model does not support tool use", 400);
    }

    const callStartTime = Date.now();

    // Process images: resolve to data URIs for the inference node, store S3
    // refs (or original URLs) in the DB version.
    const { messagesForLLM, messagesForDB } = await processMessageImages(
      body.messages as ApiCallInputMessage[],
      auth.orgId,
      imageStore,
    );
    const inputMessages = messagesForDB;

    // Build fetch body. everything passes through in OpenAI format
    const fetchBody: Record<string, unknown> = {
      model: modelInfo.model,
      messages: messagesForLLM,
      stream: body.stream,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      top_p: body.top_p,
      frequency_penalty: body.frequency_penalty,
      presence_penalty: body.presence_penalty,
      seed: body.seed,
      response_format: body.response_format,
      tools: body.tools,
      tool_choice: body.tool_choice,
    };
    if (body.stream) fetchBody.stream_options = { include_usage: true };
    if (body.structured_outputs) fetchBody.structured_outputs = body.structured_outputs;
    // Merge allowed extra request params directly into body
    const extraParams = extractAllowedRequestParams(rawBody, modelInfo.requestParams);
    if (extraParams) Object.assign(fetchBody, extraParams);

    const logFields = {
      auth,
      modelInfo,
      modelSpecifier: originalModel,
      inputMessages,
      callStartTime,
      logCalls: body.store,
      metadata: body.metadata ?? undefined,
    } as const;

    const backendResponse = await fetch(`http://${modelInfo.host}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fetchBody),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(env.BACKEND_TIMEOUT_MS)]),
    });

    if (!backendResponse.ok) {
      return forwardBackendError(backendResponse, log);
    }

    if (body.stream) {
      let collectedUsage: z.infer<typeof BackendUsageSchema> | undefined;
      let deltaModel = originalModel;
      const accumByChoice = new Map<number, {
        content: string; role: string;
        tool_calls?: unknown[]; finish_reason?: string | null;
      }>();

      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const event of readSSEStream(backendResponse)) {
              if (event.data === "[DONE]") {
                controller.enqueue(sseEncoder.encode("data: [DONE]\n\n"));
                break;
              }

              let json: unknown;
              try { json = JSON.parse(event.data); } catch {
                log.warn({ data: event.data }, "Non-JSON SSE chunk from backend, skipping");
                continue;
              }
              const parsed = BackendChatChunkSchema.safeParse(json);
              if (!parsed.success) {
                log.warn({ issues: parsed.error.issues }, "Malformed backend SSE chunk, skipping");
                continue;
              }
              const chunk = { ...parsed.data, model: originalModel };

              if (chunk.usage) collectedUsage = chunk.usage;
              if (chunk.choices.length) {
                deltaModel = chunk.model;
                for (const choice of chunk.choices) {
                  const acc = accumByChoice.get(choice.index) ?? { content: "", role: "assistant" };
                  acc.content += typeof choice.delta.content === "string" ? choice.delta.content : "";
                  if (choice.delta.role) acc.role = choice.delta.role as string;
                  if (Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0)
                    acc.tool_calls = choice.delta.tool_calls as unknown[];
                  if (choice.finish_reason) acc.finish_reason = choice.finish_reason;
                  accumByChoice.set(choice.index, acc);
                }
              }

              controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.close();

            logChatUsage({
              ...logFields,
              usage: collectedUsage,
              outputData: [...accumByChoice.entries()]
                .sort(([a], [b]) => a - b)
                .map(([idx, acc]) => ({
                  model: deltaModel,
                  choices: [{
                    index: idx,
                    delta: { role: acc.role, content: acc.content, ...(acc.tool_calls ? { tool_calls: acc.tool_calls } : {}) },
                    finish_reason: acc.finish_reason ?? null,
                  }],
                })),
              stream: true,
            });
          } catch (e) {
            handleStreamError(e, controller, log);
          }
        },
      });

      return new Response(stream, { headers: SSE_RESPONSE_HEADERS });

    } else {
      // Non-streaming: always forward, extract logging data field-by-field
      let raw: Record<string, unknown>;
      try {
        raw = await backendResponse.json() as Record<string, unknown>;
      } catch {
        return errorResponse("Backend returned an invalid response", 502);
      }

      // Override model with the user-facing specifier
      raw.model = originalModel;

      // Field-by-field extraction for logging each field independent so one
      // malformed field can't block extraction of the others
      const choicesResult = z.array(z.looseObject({
        index: z.number(),
        message: z.looseObject({
          role: z.string(),
          content: z.string().nullable().optional(),
          tool_calls: z.array(z.looseObject({
            id: z.string(),
            type: z.string(),
            function: z.looseObject({ name: z.string(), arguments: z.string() }),
          })).optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      })).safeParse(raw.choices);

      const usageResult = BackendUsageSchema.safeParse(raw.usage);

      if (choicesResult.success) {
        logChatUsage({
          ...logFields,
          usage: usageResult.success ? usageResult.data : undefined,
          outputData: { model: originalModel, choices: choicesResult.data },
          stream: false,
        });
      } else {
        log.warn({ issues: choicesResult.error.issues }, "Could not extract choices for logging");
      }

      return Response.json(raw);
    }

  } catch (error) {
    return handleEndpointError(error, log);
  }
}
