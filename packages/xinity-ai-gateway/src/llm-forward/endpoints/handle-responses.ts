import { streamText, isLoopFinished, stepCountIs } from "ai";
import { resolveAuthorizedModel } from "../ai-sdk";
import { errorResponse, logChatUsage, recordUsage, validateModelType, toModelMessages, SSE_RESPONSE_HEADERS, validationError, isUpstreamError, upstreamHttpStatus, modelLacksToolSupport } from "../util";
import { deleteResponse, getResponse, saveResponse, type ResponseCreation } from "../response-store";
import { rootLogger } from "../../logger";
import { processMessageImages, imageStore } from "../../image-store";
import { env } from "../../env";
import { DEEP_RESEARCH_SYSTEM_PROMPT, createCompactionStep } from "../deep-research";
import { hasSearchProvider } from "../tools/response-tools";
import { CreateResponseBodySchema, type ResponseObject } from "../responses/schemas";
import { resolveActiveTools, type ToolCallItem, type ToolResultData } from "../responses/tools";
import { buildInputItems, parseInputItemCursor, type IncludeValue } from "../responses/items";
import { buildGenerationParams, buildOutputConfig } from "../responses/generation-params";
import { createResponseStream } from "../responses/stream";
import { withResponseIdRoute } from "../endpoint-guards";
import { extractText, normalizeMessages, extractPreviousMessages, type StoredResponse } from "../responses/input-normalize";
import { loadResponse, loadResponseInputItems } from "../responses/persistence";
import {
  createAndSaveInProgressResponse,
  saveFailedResponse,
  generateAndPersistCompletedResponse,
  runBackground,
} from "../responses/generate";

const log = rootLogger.child({ name: "handle-responses" });

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

// ---------------------------------------------------------------------------
// GET / DELETE /v1/responses/:responseId
// ---------------------------------------------------------------------------

export const handleGetOrDeleteResponseRequest = withResponseIdRoute(
  ["GET", "DELETE"],
  async ({ auth, responseId, req }) => {
    if (req.method === "GET") {
      const stored = await getResponse(auth.orgId, responseId);
      if (!stored) return errorResponse("Not found", 404);
      return Response.json(stored);
    }

    if (!await deleteResponse(auth.orgId, responseId)) {
      return errorResponse("Could not delete response", 500);
    }
    return Response.json({ id: responseId, object: "response", deleted: true });
  },
);

// ---------------------------------------------------------------------------
// GET /v1/responses/:responseId/input_items
// ---------------------------------------------------------------------------

const DEFAULT_INPUT_ITEM_LIMIT = 20;
const MAX_INPUT_ITEM_LIMIT = 100;

function parseLimit(raw: string | null): number | null {
  if (raw === null) {
    return DEFAULT_INPUT_ITEM_LIMIT;
  }
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INPUT_ITEM_LIMIT) {
    return null;
  }
  return limit;
}

export const handleListInputItemsRequest = withResponseIdRoute(["GET"], async ({ auth, responseId, req }) => {
  const params = new URL(req.url).searchParams;

  const limit = parseLimit(params.get("limit"));
  if (limit === null) {
    return errorResponse(`'limit' must be an integer between 1 and ${MAX_INPUT_ITEM_LIMIT}`, 400);
  }

  const order = params.get("order") ?? "desc";
  if (order !== "asc" && order !== "desc") {
    return errorResponse("'order' must be 'asc' or 'desc'", 400);
  }

  const cursor = params.get("after");
  const afterSeq = cursor === null ? null : parseInputItemCursor(responseId, cursor);
  if (cursor !== null && afterSeq === null) {
    return errorResponse("'after' is not an item of this response", 400);
  }

  // Only stored responses have input to list; a store:false response lives in the cache
  // with its output but was never recorded with the messages it was built from.
  const page = await loadResponseInputItems(auth.orgId, responseId, {
    limit,
    ascending: order === "asc",
    afterSeq,
  });
  if (page.messages.length === 0 && afterSeq === null && !await loadResponse(auth.orgId, responseId)) {
    return errorResponse("Not found", 404);
  }

  const data = buildInputItems(responseId, page.messages);
  return Response.json({
    object: "list",
    data,
    has_more: page.hasMore,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  });
});

// ---------------------------------------------------------------------------
// POST /v1/responses/:responseId/cancel
// ---------------------------------------------------------------------------

export const handleCancelResponseRequest = withResponseIdRoute(["POST"], async ({ auth, responseId }) => {
  const stored = await getResponse(auth.orgId, responseId) as ResponseObject | null;
  if (!stored) {
    return errorResponse("Not found", 404);
  }
  if (stored.status !== "in_progress") {
    return errorResponse("Response is not in progress", 400);
  }

  const cancelledResponse = { ...stored, status: "cancelled" as const };
  await saveResponse(auth.orgId, responseId, cancelledResponse);

  return Response.json(cancelledResponse);
});
