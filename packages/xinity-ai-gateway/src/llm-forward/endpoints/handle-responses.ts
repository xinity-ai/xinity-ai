import { streamText, isLoopFinished, stepCountIs } from "ai";
import { resolveAuthorizedModel } from "../ai-sdk";
import { errorResponse, logChatUsage, recordUsage, validateModelType, toModelMessages, SSE_RESPONSE_HEADERS, validationError, isUpstreamError, upstreamHttpStatus, modelLacksToolSupport } from "../util";
import { deleteResponse, getResponse, getResponseMessages, saveResponse, type ResponseCreation } from "../response-store";
import { rootLogger } from "../../logger";
import { processMessageImages, restoreMessageImages, imageStore } from "../../image-store";
import { env } from "../../env";
import { DEEP_RESEARCH_SYSTEM_PROMPT, createCompactionStep } from "../deep-research";
import { hasSearchProvider } from "../tools/response-tools";
import { CreateResponseBodySchema, type CreateResponseBody, type ResponseObject } from "../responses/schemas";
import { resolveActiveTools, type ResolvedTools, type ToolCallItem, type ToolResultData } from "../responses/tools";
import { buildInputItems, parseInputItemCursor, type IncludeValue } from "../responses/items";
import { buildGenerationParams, buildOutputConfig } from "../responses/generation-params";
import type { ApiCallInputMessage } from "common-db";
import { createResponseStream } from "../responses/stream";
import { withResponseIdRoute } from "../endpoint-guards";
import { extractText, normalizeMessages } from "../responses/input-normalize";
import { loadResponse, loadResponseInputItems } from "../responses/persistence";
import { newResponseId } from "../responses/response-id";
import { callWillBeLogged, type CallLogFields } from "../usage";
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

type Authorized = Exclude<Awaited<ReturnType<typeof resolveAuthorizedModel>>, Response>;
type GenerationParams = ReturnType<typeof buildGenerationParams>;

/** Everything the four modes share, resolved once before any of them is chosen. */
type PreparedRequest = Omit<Authorized, "body"> & {
  body: CreateResponseBody;
  responseId: string;
  createdAt: number;
  input: unknown;
  messagesForLLM: ApiCallInputMessage[];
  messagesForDB: ApiCallInputMessage[];
  include: IncludeValue[];
  outputConfig: ReturnType<typeof buildOutputConfig>;
  activeTools: ResolvedTools["activeTools"];
  hasTools: boolean;
  callStartTime: number;
  logFields: CallLogFields;
  creation: ResponseCreation;
};

async function prepareResponseRequest(req: Request): Promise<PreparedRequest | Response> {
  const authorized = await resolveAuthorizedModel(req);
  if (authorized instanceof Response) return authorized;
  const { auth, body: rawBody, originalModel, modelInfo } = authorized;

  const typeError = validateModelType(modelInfo, ["chat"]);
  if (typeError) return typeError;

  const parseResult = CreateResponseBodySchema.safeParse(rawBody);
  if (!parseResult.success) {
    return validationError(parseResult.error);
  }
  const body = parseResult.data;

  const input = body.input ?? body.messages ?? body.prompt;
  const messages = normalizeMessages(input);
  if (!messages) return errorResponse("Unsupported data type", 422);

  const outputConfig = buildOutputConfig(body.text ?? null);
  const { activeTools } = resolveActiveTools(body.tools ?? [], body.tool_choice);
  const hasTools = Object.keys(activeTools).length > 0;

  if (body.background && body.stream) {
    return errorResponse("'background' and 'stream' cannot both be true", 400);
  }
  if (body.background && body.store === false) {
    return errorResponse("'background' requires 'store' to be true", 400);
  }
  if (hasTools && modelLacksToolSupport(modelInfo)) {
    return errorResponse("Model does not support tool use", 400);
  }
  if (outputConfig.usesStructuredOutput && modelLacksToolSupport(modelInfo)) {
    return errorResponse("Model does not support structured output", 400);
  }

  const callStartTime = Date.now();

  let historyForModel: ApiCallInputMessage[] = [];
  let historyForLog: ApiCallInputMessage[] = [];
  if (body.previous_response_id) {
    const previousResponse = await getResponse(auth.orgId, body.previous_response_id);
    if (!previousResponse) return errorResponse("Not found", 404);
    // A stored response keeps the whole conversation it was part of, answer included, so
    // reading one hop back carries all of it however long the exchange has run.
    historyForLog = await getResponseMessages(auth.orgId, body.previous_response_id);
    // Logged messages carry `xinity-media://` references, which no backend can fetch.
    historyForModel = await restoreMessageImages(historyForLog, auth.orgId, imageStore);
  }

  const willLog = callWillBeLogged(auth, body.store);
  const processed = await processMessageImages(messages, auth.orgId, imageStore, willLog);
  const messagesForLLM = [...historyForModel, ...processed.messagesForLLM];
  const messagesForDB = [...historyForLog, ...processed.messagesForDB];

  // Reserved up front because the response settles before the log is flushed, and only when
  // the call will be logged, so the column never names a row that was never written.
  const inferenceCallId = willLog ? crypto.randomUUID() : null;

  return {
    ...authorized,
    body,
    responseId: newResponseId(),
    createdAt: Math.floor(Date.now() / 1000),
    input,
    messagesForLLM,
    messagesForDB,
    include: (body.include ?? []) as IncludeValue[],
    outputConfig,
    activeTools,
    hasTools,
    callStartTime,
    logFields: {
      auth,
      modelInfo,
      publicSpecifier: originalModel,
      endpoint: "responses" as const,
      inferenceCallId,
      inputMessages: messagesForDB,
      callStartTime,
      logCalls: body.store,
      metadata: body.metadata as Record<string, unknown> | undefined,
    },
    creation: {
      inferenceCallId,
      apiKeyId: auth.keyId,
      applicationId: auth.applicationId,
      inputMessages: messagesForDB,
    },
  };
}

async function runDeepResearch(prepared: PreparedRequest): Promise<Response> {
  const {
    auth, body, modelInfo, provider, originalModel, baseModelName,
    responseId, createdAt, input, messagesForLLM, include, outputConfig, logFields, creation, callStartTime,
  } = prepared;

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

  const systemPrompt = DEEP_RESEARCH_SYSTEM_PROMPT + (body.instructions ? "\n\n" + body.instructions : "");
  messagesForLLM.unshift({ role: "system", content: systemPrompt });

  const { activeTools: deepTools } = resolveActiveTools(
    [...(body.tools ?? []), { type: "web_search" }],
    body.tool_choice ?? "auto",
  );

  const compactionUsage = { inputTokens: 0, outputTokens: 0 };
  const genParams = {
    ...buildGenerationParams(body, modelInfo, provider, toModelMessages(messagesForLLM), deepTools, true, outputConfig),
    stopWhen: [isLoopFinished(), stepCountIs(env.DEEP_RESEARCH_MAX_STEPS)],
    prepareStep: createCompactionStep(
      provider, modelInfo.model, modelInfo.maxContextLength,
      env.DEEP_RESEARCH_COMPACTION_THRESHOLD, extractText(input) ?? "",
      (usage) => {
        compactionUsage.inputTokens += usage.inputTokens;
        compactionUsage.outputTokens += usage.outputTokens;
        recordUsage({ usage, auth, modelInfo, callStartTime, logCalls: false, deployment: originalModel });
      },
    ),
  };

  const baseResponse = await createAndSaveInProgressResponse(auth.orgId, responseId, createdAt, originalModel, body, creation);
  void runBackground({
    orgId: auth.orgId, responseId, createdAt, originalModel, body,
    genParams, include, outputConfig, logFields, deepResearch: { compactionUsage },
  });
  return Response.json(baseResponse, { status: 202 });
}

async function runInBackground(prepared: PreparedRequest, genParams: GenerationParams): Promise<Response> {
  const { auth, body, originalModel, responseId, createdAt, include, outputConfig, logFields, creation } = prepared;

  const baseResponse = await createAndSaveInProgressResponse(auth.orgId, responseId, createdAt, originalModel, body, creation);
  void runBackground({ orgId: auth.orgId, responseId, createdAt, originalModel, body, genParams, include, outputConfig, logFields });
  return Response.json(baseResponse, { status: 202 });
}

async function runStreaming(prepared: PreparedRequest, genParams: GenerationParams): Promise<Response> {
  const { auth, body, originalModel, responseId, createdAt, include, logFields, creation } = prepared;

  const toolCalls: ToolCallItem[] = [];
  const toolResults: ToolResultData[] = [];
  const baseResponse = await createAndSaveInProgressResponse(auth.orgId, responseId, createdAt, originalModel, body, creation);

  const streamBody = createResponseStream({
    result: streamText(genParams),
    orgId: auth.orgId, responseId, messageItemId: `msg_${responseId}`, createdAt, originalModel, body,
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

async function runBlocking(prepared: PreparedRequest, genParams: GenerationParams): Promise<Response> {
  const { auth, body, originalModel, responseId, createdAt, include, outputConfig, logFields, creation } = prepared;

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
}

export async function handleCreateResponseRequest(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") return errorResponse("Method not allowed", 405);

    const prepared = await prepareResponseRequest(req);
    if (prepared instanceof Response) return prepared;

    if (prepared.deepResearch) {
      return runDeepResearch(prepared);
    }

    const { body, modelInfo, provider, messagesForLLM, activeTools, hasTools, outputConfig } = prepared;
    const genParams = buildGenerationParams(
      body, modelInfo, provider, toModelMessages(messagesForLLM), activeTools, hasTools, outputConfig, req.signal,
    );

    if (body.background) {
      return runInBackground(prepared, genParams);
    }
    if (body.stream) {
      return runStreaming(prepared, genParams);
    }
    return runBlocking(prepared, genParams);
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
