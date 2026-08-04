import { generateText, streamText, isLoopFinished, stepCountIs } from "ai";
import { resolveAuthorizedModel } from "../ai-sdk";
import { errorResponse, logChatUsage, recordUsage, validateModelType, toModelMessages, SSE_RESPONSE_HEADERS, validationError, isUpstreamError, upstreamHttpStatus, clientFacingErrorMessage, modelLacksToolSupport } from "../util";
import type { ApiCallInputMessage } from "common-db";
import { checkAuth, type AuthResult } from "../auth";
import { deleteResponse, getResponse, saveResponse, type ResponseCreation } from "../response-store";
import { rootLogger } from "../../logger";
import { processMessageImages, imageStore } from "../../image-store";
import { env } from "../../env";
import { DEEP_RESEARCH_SYSTEM_PROMPT, createCompactionStep } from "../deep-research";
import { hasSearchProvider } from "../tools/response-tools";
import {
  CreateResponseBodySchema,
  type CreateResponseBody,
  type OutputItem,
  type ResponseObject,
} from "../responses/schemas";
import {
  type IncludeValue,
  type ToolCallItem,
  type ToolResultData,
  createToolTracker,
  resolveActiveTools,
  buildOutputConfig,
  resolveResponseText,
  createResponseObject,
  markResponseFailed,
  buildOutputItems,
  buildStepOutputItems,
  extractSearchAnnotations,
  formatUsage,
  buildGenerationParams,
} from "../responses/builders";
import { createResponseStream } from "../responses/stream";

const log = rootLogger.child({ name: "handle-responses" });

async function checkCancelled(orgId: string, responseId: string): Promise<boolean> {
  const stored = await getResponse(orgId, responseId) as { status?: string } | null;
  return stored?.status === "cancelled";
}

// ---------------------------------------------------------------------------
// Message normalisation
// ---------------------------------------------------------------------------

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        const p = part as Record<string, unknown> | null;
        if (p && typeof p.text === "string") return p.text;
        if (p && typeof p.content === "string") return p.content;
        return null;
      })
      .filter(Boolean);
    return parts.length ? parts.join("") : null;
  }
  const c = content as Record<string, unknown> | null;
  if (c && typeof c.text === "string") return c.text;
  return null;
}

type TextMessageRole = "user" | "assistant" | "system";
const VALID_TEXT_ROLES = new Set<TextMessageRole>(["user", "assistant", "system"]);

function normalizeRole(raw: unknown): TextMessageRole {
  if (typeof raw === "string" && VALID_TEXT_ROLES.has(raw as TextMessageRole)) return raw as TextMessageRole;
  return "user";
}

/** Extract content parts, preserving image_url entries alongside text. */
function extractContent(raw: unknown): string | ApiCallInputMessage["content"] | null {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
    for (const part of raw) {
      if (typeof part === "string") {
        parts.push({ type: "text", text: part });
        continue;
      }
      const p = part as Record<string, unknown> | null;
      if (!p) continue;
      if (p.type === "image_url" && p.image_url && typeof (p.image_url as Record<string, unknown>).url === "string") {
        parts.push({ type: "image_url", image_url: { url: (p.image_url as { url: string }).url } });
        continue;
      }
      if (typeof p.text === "string") parts.push({ type: "text", text: p.text });
      else if (typeof p.content === "string") parts.push({ type: "text", text: p.content });
    }
    if (!parts.length) return null;
    const [first] = parts;
    if (parts.length === 1 && first?.type === "text") return first.text;
    return parts;
  }
  return extractText(raw);
}

function normalizeMessages(input: unknown): ApiCallInputMessage[] | null {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (Array.isArray(input)) {
    if (input.every((item) => typeof item === "string"))
      return input.map((text) => ({ role: "user", content: text }));
    const messages: ApiCallInputMessage[] = [];
    for (const item of input) {
      if (!item || typeof item !== "object") return null;
      const obj = item as Record<string, unknown>;

      // Handle function_call_output items (client returning function tool results)
      if (obj.type === "function_call_output") {
        const output = typeof obj.output === "string" ? obj.output : JSON.stringify(obj.output ?? "");
        messages.push({
          role: "tool",
          content: output,
          tool_call_id: obj.call_id as string,
        } as ApiCallInputMessage);
        continue;
      }

      const role = normalizeRole(obj.role);
      const content = extractContent(obj.content ?? obj.input ?? obj.text);
      if (!content) return null;
      messages.push({ role, content } as ApiCallInputMessage);
    }
    return messages;
  }
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const role = normalizeRole(obj.role);
    const content = extractContent(obj.content ?? obj.input ?? obj.text);
    if (!content) return null;
    return [{ role, content } as ApiCallInputMessage];
  }
  return null;
}

type StoredResponse = {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
    // function_call fields
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
};

function extractPreviousMessages(stored: StoredResponse): ApiCallInputMessage[] {
  const messages: ApiCallInputMessage[] = [];
  // Collect function_call items to inject as a single assistant tool_calls message
  const functionCalls: Array<{ call_id: string; name: string; arguments: string }> = [];

  for (const item of stored.output ?? []) {
    if (item.type === "message") {
      const textParts = (item.content ?? [])
        .filter((c) => c.type === "output_text" && typeof c.text === "string")
        .map((c) => c.text as string);
      if (textParts.length) messages.push({ role: "assistant", content: textParts.join("") });
    } else if (item.type === "function_call" && item.call_id && item.name) {
      functionCalls.push({
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments ?? "{}",
      });
    }
  }

  // Re-inject function calls as an assistant tool_calls message so the AI SDK
  // can continue the conversation when the client sends function_call_output
  if (functionCalls.length) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: functionCalls.map((fc) => ({
        id: fc.call_id,
        type: "function" as const,
        function: { name: fc.name, arguments: fc.arguments },
      })),
    } as ApiCallInputMessage);
  }

  return messages;
}

// ---------------------------------------------------------------------------
// POST /v1/responses
// ---------------------------------------------------------------------------

export async function handleCreateResponseRequest(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") return errorResponse("Method not allowed", 405);

    const authorized = await resolveAuthorizedModel(req);
    if (authorized instanceof Response) return authorized;
    const { auth, body: rawBody, originalModel, baseModelName, deepResearch, modelInfo, provider } = authorized;

    const typeError = validateModelType(modelInfo, ["chat"]);
    if (typeError) return typeError;

    // Validate request body
    const parseResult = CreateResponseBodySchema.safeParse(rawBody);
    if (!parseResult.success) {
      return validationError(parseResult.error);
    }
    const body = parseResult.data;

    const responseId = `resp_${crypto.randomUUID()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const input = body.input ?? body.messages ?? body.prompt;
    const messages = normalizeMessages(input);
    if (!messages) return errorResponse("Unsupported data type", 422);

    const include = (body.include ?? []) as IncludeValue[];
    const textConfig = body.text ?? null;
    const outputConfig = buildOutputConfig(textConfig);
    const { activeTools } = resolveActiveTools(body.tools ?? [], body.tool_choice);
    const hasTools = Object.keys(activeTools).length > 0;

    if (body.background && body.stream) {
      return errorResponse("'background' and 'stream' cannot both be true", 400);
    }
    if (body.background && body.store === false) {
      return errorResponse("'background' requires 'store' to be true", 400);
    }
    const background = body.background;
    const stream = body.stream;

    const callStartTime = Date.now();

    // Load previous response context (before image processing so previous
    // messages are included in the LLM context but not re-processed)
    if (body.previous_response_id) {
      const previousResponse = await getResponse(auth.orgId, body.previous_response_id);
      if (!previousResponse) return errorResponse("Not found", 404);
      const previousMessages = extractPreviousMessages(previousResponse as StoredResponse);
      if (previousMessages.length) messages.unshift(...previousMessages);
    }

    // Process images in the new messages (excludes previously loaded context)
    const { messagesForLLM, messagesForDB } = await processMessageImages(
      messages,
      auth.orgId,
      imageStore,
    );

    const logFields = {
      auth,
      modelInfo,
      publicSpecifier: originalModel,
      inputMessages: messagesForDB,
      callStartTime,
      logCalls: body.store,
      metadata: body.metadata as Record<string, unknown> | undefined,
    } as const;

    const creation: ResponseCreation = {
      apiKeyId: auth.keyId,
      applicationId: auth.applicationId,
      inputMessages: messagesForDB,
    };

    if (hasTools && modelLacksToolSupport(modelInfo)) {
      return errorResponse("Model does not support tool use", 400);
    }

    if (outputConfig.usesStructuredOutput && modelLacksToolSupport(modelInfo)) {
      return errorResponse("Model does not support structured output", 400);
    }

    // -------------------------------------------------------------------
    // Deep research mode
    // -------------------------------------------------------------------
    if (deepResearch) {
      if (body.stream) {
        return errorResponse(
          "Streaming is not supported for deep research requests. Deep research runs in background mode. Poll the response ID for results.",
          400,
        );
      }
      if (!hasSearchProvider()) {
        return errorResponse("Deep research requires web search to be configured (WEB_SEARCH_PROVIDER + WEB_SEARCH_CREDENTIAL)", 501);
      }
      if (modelLacksToolSupport(modelInfo)) {
        return errorResponse(
          `Model '${baseModelName}' does not support tool calling, which is required for deep research.`,
          400,
        );
      }

      // Inject research system prompt
      const systemPrompt = DEEP_RESEARCH_SYSTEM_PROMPT + (body.instructions ? "\n\n" + body.instructions : "");
      messagesForLLM.unshift({ role: "system", content: systemPrompt });

      // Force web_search + web_fetch into active tools (merge with user-provided tools)
      const { activeTools: deepTools } = resolveActiveTools(
        [...(body.tools ?? []), { type: "web_search" }],
        body.tool_choice ?? "auto",
      );

      const maxSteps = env.DEEP_RESEARCH_MAX_STEPS;
      const contextLimit = modelInfo.maxContextLength;
      const userQuery = extractText(input) ?? "";

      const compactionUsage = { inputTokens: 0, outputTokens: 0 };

      const deepGenParams = {
        ...buildGenerationParams(body, modelInfo, provider, toModelMessages(messagesForLLM), deepTools, true, outputConfig),
        stopWhen: [isLoopFinished(), stepCountIs(maxSteps)],
        prepareStep: createCompactionStep(
          provider, modelInfo.model, contextLimit,
          env.DEEP_RESEARCH_COMPACTION_THRESHOLD, userQuery,
          (usage) => {
            compactionUsage.inputTokens += usage.inputTokens;
            compactionUsage.outputTokens += usage.outputTokens;
            recordUsage({
              usage,
              auth,
              modelInfo,
              callStartTime,
              logCalls: false,
              deployment: originalModel,
            });
          },
        ),
      };

      const baseResponse = await createAndSaveInProgressResponse(auth.orgId, responseId, createdAt, originalModel, body, creation);

      void runBackground({ orgId: auth.orgId, responseId, createdAt, originalModel, body, genParams: deepGenParams, include, outputConfig, logFields, deepResearch: { compactionUsage } });

      return Response.json(baseResponse, { status: 202 });
    }

    const genParams = buildGenerationParams(body, modelInfo, provider, toModelMessages(messagesForLLM), activeTools, hasTools, outputConfig, req.signal);

    // -------------------------------------------------------------------
    // Background mode
    // -------------------------------------------------------------------
    if (background) {
      const baseResponse = await createAndSaveInProgressResponse(auth.orgId, responseId, createdAt, originalModel, body, creation);

      void runBackground({ orgId: auth.orgId, responseId, createdAt, originalModel, body, genParams, include, outputConfig, logFields });

      return Response.json(baseResponse, { status: 202 });
    }

    // -------------------------------------------------------------------
    // Streaming mode
    // -------------------------------------------------------------------
    if (stream) {
      const messageItemId = `msg_${responseId}`;
      const toolCalls: ToolCallItem[] = [];
      const toolResults: ToolResultData[] = [];

      const baseResponse = await createAndSaveInProgressResponse(auth.orgId, responseId, createdAt, originalModel, body, creation);

      // Tool tracking happens inline in the stream for consistent IDs
      const result = streamText(genParams);

      const streamBody = createResponseStream({
        result, orgId: auth.orgId, responseId, messageItemId, createdAt, originalModel, body,
        baseResponse, toolCalls, toolResults, include,
        onFinished: (usage, text) => {
          logChatUsage({
            ...logFields,
            usage,
            outputData: [{ model: originalModel, choices: [{ index: 0, delta: { role: "assistant", content: text } }] }],
            stream: true,
          });
        },
      });

      return new Response(streamBody, { headers: SSE_RESPONSE_HEADERS });
    }

    // -------------------------------------------------------------------
    // Non-streaming mode (default)
    // -------------------------------------------------------------------
    await createAndSaveInProgressResponse(auth.orgId, responseId, createdAt, originalModel, body, creation);
    try {
      const responseBody = await generateAndPersistCompletedResponse({
        orgId: auth.orgId, responseId, createdAt, originalModel,
        body, genParams, include, outputConfig, logFields,
      });
      return Response.json(responseBody);
    } catch (error) {
      await saveFailedResponse(auth.orgId, responseId, createdAt, originalModel, body, error);
      throw error;
    }
  } catch (error) {
    if (isUpstreamError(error)) {
      log.error({ err: error }, "Upstream error");
      return errorResponse(error.message || "Bad Gateway", upstreamHttpStatus(error));
    }
    log.error({ err: error }, "Internal gateway error");
    return errorResponse("Internal Server Error", 500);
  }
}

async function createAndSaveInProgressResponse(
  orgId: string,
  responseId: string,
  createdAt: number,
  originalModel: string,
  body: CreateResponseBody,
  creation: ResponseCreation,
) {
  const baseResponse = createResponseObject({
    responseId, createdAt, model: originalModel, status: "in_progress", body,
  });
  await saveResponse(orgId, responseId, baseResponse, creation);
  return baseResponse;
}

/** Settles the row a failed run would otherwise leave sitting at in_progress. */
async function saveFailedResponse(
  orgId: string,
  responseId: string,
  createdAt: number,
  originalModel: string,
  body: CreateResponseBody,
  error: unknown,
): Promise<void> {
  const failedResponse = markResponseFailed(
    createResponseObject({ responseId, createdAt, model: originalModel, status: "failed", body }),
    clientFacingErrorMessage(error),
  );
  await saveResponse(orgId, responseId, failedResponse)
    .catch((err) => log.error({ err, responseId }, "Failed to persist failed response"));
}

// ---------------------------------------------------------------------------
// Background execution
// ---------------------------------------------------------------------------

type LogFields = {
  readonly auth: AuthResult;
  readonly modelInfo: { model: string };
  readonly publicSpecifier: string;
  readonly inputMessages: ApiCallInputMessage[];
  readonly callStartTime: number;
  readonly logCalls: boolean | undefined;
  readonly metadata: Record<string, unknown> | undefined;
};

type GeneratePersistArgs = {
  orgId: string;
  responseId: string;
  createdAt: number;
  originalModel: string;
  body: CreateResponseBody;
  genParams: Omit<ReturnType<typeof buildGenerationParams>, "stopWhen"> & Pick<Parameters<typeof generateText>[0], "prepareStep" | "stopWhen">;
  include: IncludeValue[];
  outputConfig: ReturnType<typeof buildOutputConfig>;
  logFields: LogFields;
  deepResearch?: {
    compactionUsage: { inputTokens: number; outputTokens: number };
  };
};

function createWriteQueue(onError: (err: unknown) => void) {
  let tail = Promise.resolve();
  return {
    enqueue(write: () => Promise<void>) {
      tail = tail.then(write).catch(onError);
    },
    flush() {
      return tail;
    },
  };
}

async function generateAndPersistCompletedResponse(args: GeneratePersistArgs, background = false) {
  const { orgId, responseId, createdAt, originalModel, body, genParams, include, outputConfig, logFields, deepResearch } = args;
  const toolCalls: ToolCallItem[] = [];
  const toolResults: ToolResultData[] = [];

  const cancelCheck = () => checkCancelled(orgId, responseId);
  const existingStop = genParams.stopWhen;
  const priorConditions = Array.isArray(existingStop) ? existingStop : existingStop ? [existingStop] : [];
  const stopConditions = background
    ? [...priorConditions, cancelCheck]
    : existingStop;

  const progressItems: OutputItem[] = [];
  const progressWrites = createWriteQueue((err) => {
    log.warn({ err, responseId }, "Failed to persist research progress");
  });
  const stepUsage = { inputTokens: 0, outputTokens: 0 };

  type StepEvent = {
    toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>;
    toolResults?: Array<Record<string, unknown>>;
    usage?: { inputTokens?: number; outputTokens?: number };
  };

  const onStepFinish: (event: StepEvent) => void = deepResearch
    ? (step) => {
        stepUsage.inputTokens += step.usage?.inputTokens ?? 0;
        stepUsage.outputTokens += step.usage?.outputTokens ?? 0;

        if (step.toolResults) {
          for (const tr of step.toolResults) {
            const id = tr.toolCallId;
            const name = tr.toolName;
            if (typeof id === "string" && typeof name === "string") {
              toolResults.push({ toolCallId: id, toolName: name, args: tr.input, result: tr.output });
            }
          }
        }

        const newItems = buildStepOutputItems(step.toolCalls, step.toolResults, include);
        if (newItems.length === 0) return;
        progressItems.push(...newItems);

        const totalUsage = {
          inputTokens: stepUsage.inputTokens + deepResearch.compactionUsage.inputTokens,
          outputTokens: stepUsage.outputTokens + deepResearch.compactionUsage.outputTokens,
        };
        const snapshot = [...progressItems];
        progressWrites.enqueue(async () => {
          const stored = await getResponse(orgId, responseId) as ResponseObject | null;
          if (!stored || stored.status === "cancelled") return;
          stored.output = snapshot;
          stored.usage = formatUsage(totalUsage);
          await saveResponse(orgId, responseId, stored);
        });
      }
    : createToolTracker(toolCalls, toolResults);

  const result = await generateText({
    ...genParams,
    stopWhen: stopConditions as Parameters<typeof generateText>[0]["stopWhen"],
    onStepFinish,
  });

  if (background && await checkCancelled(orgId, responseId)) {
    return;
  }

  await progressWrites.flush();

  const responseText = resolveResponseText(result.text, () => result.output, outputConfig.usesStructuredOutput);

  const finalUsage = deepResearch
    ? {
        inputTokens: (result.usage.inputTokens ?? 0) + deepResearch.compactionUsage.inputTokens,
        outputTokens: (result.usage.outputTokens ?? 0) + deepResearch.compactionUsage.outputTokens,
      }
    : result.usage;

  let finalOutput: OutputItem[];
  if (deepResearch) {
    const annotations = extractSearchAnnotations(toolResults);
    progressItems.push({
      id: `msg_${responseId}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: responseText, annotations, logprobs: null }],
    });
    finalOutput = progressItems;
  } else {
    finalOutput = buildOutputItems(responseId, responseText, toolCalls, toolResults, include, result.reasoning.map(part => part.text));
  }

  const completedResponse = createResponseObject({
    responseId, createdAt, model: originalModel, status: "completed",
    output: finalOutput, usage: finalUsage, body,
  });
  await saveResponse(orgId, responseId, completedResponse);
  logChatUsage({
    ...logFields,
    usage: finalUsage,
    outputData: { model: originalModel, choices: [{ index: 0, message: { role: "assistant", content: responseText } }] },
    stream: false,
  });
  return completedResponse;
}

async function runBackground(args: GeneratePersistArgs) {
  const { orgId, responseId, createdAt, originalModel, body } = args;
  try {
    await generateAndPersistCompletedResponse(args, true);
  } catch (error) {
    if (!isUpstreamError(error)) {
      log.error({ err: error, responseId }, "Background response generation failed");
    }
    await saveFailedResponse(orgId, responseId, createdAt, originalModel, body, error);
  }
}

// ---------------------------------------------------------------------------
// GET / DELETE /v1/responses/:responseId
// ---------------------------------------------------------------------------

export async function handleGetOrDeleteResponseRequest(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization") || "";
  const authCheckResponse = await checkAuth(authHeader);
  if (authCheckResponse instanceof Response) return authCheckResponse;

  const responseId = (req as Request & { params: { responseId: string } }).params.responseId;
  if (!responseId) return errorResponse("Not found", 404);

  if (req.method === "GET") {
    const stored = await getResponse(authCheckResponse.orgId, responseId);
    if (!stored) return errorResponse("Not found", 404);
    return Response.json(stored);
  }

  if (req.method === "DELETE") {
    if (!await deleteResponse(authCheckResponse.orgId, responseId)) {
      return errorResponse("Could not delete response", 500);
    }
    return Response.json({ id: responseId, object: "response", deleted: true });
  }

  return errorResponse("Method not allowed", 405);
}

// ---------------------------------------------------------------------------
// POST /v1/responses/:responseId/cancel
// ---------------------------------------------------------------------------

export async function handleCancelResponseRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const authHeader = req.headers.get("authorization") || "";
  const authCheckResponse = await checkAuth(authHeader);
  if (authCheckResponse instanceof Response) return authCheckResponse;

  const responseId = (req as Request & { params: { responseId: string } }).params.responseId;
  if (!responseId) {
    return errorResponse("Not found", 404);
  }

  const stored = await getResponse(authCheckResponse.orgId, responseId) as ResponseObject | null;
  if (!stored) {
    return errorResponse("Not found", 404);
  }
  if (stored.status !== "in_progress") {
    return errorResponse("Response is not in progress", 400);
  }

  const cancelledResponse = { ...stored, status: "cancelled" as const };
  await saveResponse(authCheckResponse.orgId, responseId, cancelledResponse);

  return Response.json(cancelledResponse);
}
