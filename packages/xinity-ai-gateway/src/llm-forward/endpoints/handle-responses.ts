import { generateText, streamText } from "ai";
import { resolveAuthorizedModel } from "../ai-sdk";
import { errorResponse, logChatUsage, validateModelType, toModelMessages } from "../util";
import type { ApiCallInputMessage } from "common-db";
import { checkAuth, type AuthResult } from "../auth";
import { deleteResponse, getResponse, saveResponse } from "../response-store";
import { rootLogger } from "../../logger";
import { processMessageImages, imageStore } from "../../image-store";

const log = rootLogger.child({ name: "handle-responses" });
import {
  CreateResponseBodySchema,
  type CreateResponseBody,
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
  buildGenerationParams,
} from "../responses/builders";
import { createResponseStream } from "../responses/stream";

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
    return parts.length === 1 && parts[0]!.type === "text" ? parts[0]!.text : parts;
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
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
};

function extractPreviousMessages(stored: StoredResponse): ApiCallInputMessage[] {
  const messages: ApiCallInputMessage[] = [];
  for (const item of stored.output ?? []) {
    if (item.type !== "message") continue;
    const textParts = (item.content ?? [])
      .filter((c) => c.type === "output_text" && typeof c.text === "string")
      .map((c) => c.text as string);
    if (textParts.length) messages.push({ role: "assistant", content: textParts.join("") });
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
    const { auth, body: rawBody, originalModel, modelInfo, provider } = authorized;

    const typeError = validateModelType(modelInfo, ["chat"]);
    if (typeError) return typeError;

    // Validate request body
    const parseResult = CreateResponseBodySchema.safeParse(rawBody);
    if (!parseResult.success) {
      return errorResponse(`Invalid request body: ${parseResult.error.issues.map((i) => i.message).join(", ")}`, 400);
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
    const activeTools = resolveActiveTools(body.tools ?? [], body.tool_choice);
    const hasTools = Object.keys(activeTools).length > 0;

    const background = body.background && !body.stream;
    const stream = body.stream && !body.background;

    const callStartTime = Date.now();

    // Load previous response context (before image processing so previous
    // messages are included in the LLM context but not re-processed)
    if (body.previous_response_id) {
      const previousResponse = await getResponse(body.previous_response_id);
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
      modelSpecifier: originalModel,
      inputMessages: messagesForDB,
      callStartTime,
      logCalls: body.store ?? true,
      metadata: body.metadata as Record<string, unknown> | undefined,
    } as const;

    if (hasTools && !modelInfo.tags.includes("tools")) {
      return errorResponse("Model does not support tool use", 400);
    }

    if (outputConfig.usesStructuredOutput && !modelInfo.tags.includes("tools")) {
      return errorResponse("Model does not support structured output", 400);
    }

    const genParams = buildGenerationParams(body, modelInfo, provider, toModelMessages(messagesForLLM), activeTools, hasTools, outputConfig, req.signal);

    // -------------------------------------------------------------------
    // Background mode
    // -------------------------------------------------------------------
    if (background) {
      const baseResponse = createResponseObject({
        responseId, createdAt, model: originalModel, status: "in_progress", body,
      });
      await saveResponse(responseId, baseResponse);

      void runBackground(responseId, createdAt, originalModel, body, genParams, include, outputConfig, logFields);

      return Response.json(baseResponse, { status: 202 });
    }

    // -------------------------------------------------------------------
    // Streaming mode
    // -------------------------------------------------------------------
    if (stream) {
      const messageItemId = `msg_${responseId}`;
      const toolCalls: ToolCallItem[] = [];
      const toolResults: ToolResultData[] = [];

      const baseResponse = createResponseObject({
        responseId, createdAt, model: originalModel, status: "in_progress", body,
      });
      await saveResponse(responseId, baseResponse);

      // Tool tracking happens inline in the stream for consistent IDs
      const result = streamText(genParams);

      const streamBody = createResponseStream({
        result, responseId, messageItemId, createdAt, originalModel, body,
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

      return new Response(streamBody, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // -------------------------------------------------------------------
    // Non-streaming mode (default)
    // -------------------------------------------------------------------
    const toolCalls: ToolCallItem[] = [];
    const toolResults: ToolResultData[] = [];

    const result = await generateText({
      ...genParams,
      onStepFinish: createToolTracker(toolCalls, toolResults),
    });

    const responseText = resolveResponseText(result.text, () => result.output, outputConfig.usesStructuredOutput);
    const responseBody = createResponseObject({
      responseId, createdAt, model: originalModel, status: "completed",
      output: buildOutputItems(responseId, responseText, toolCalls, toolResults, include),
      usage: result.usage, body,
    });

    await saveResponse(responseId, responseBody);
    logChatUsage({
      ...logFields,
      usage: result.usage,
      outputData: { model: originalModel, choices: [{ index: 0, message: { role: "assistant", content: responseText } }] },
      stream: false,
    });

    return Response.json(responseBody);
  } catch (error) {
    const isUpstreamError = error instanceof Error && (
      "statusCode" in error || "status" in error || error.name === "APICallError"
    );
    if (isUpstreamError) {
      const status = (error as Record<string, unknown>).statusCode ?? (error as Record<string, unknown>).status;
      const code = typeof status === "number" && status >= 400 ? status : 502;
      log.error({ err: error }, "Upstream error");
      return errorResponse(error.message || "Bad Gateway", code as number);
    }
    log.error({ err: error }, "Internal gateway error");
    return errorResponse(error instanceof Error ? error.message : "Internal Server Error", 500);
  }
}

// ---------------------------------------------------------------------------
// Background execution
// ---------------------------------------------------------------------------

type LogFields = {
  readonly auth: AuthResult;
  readonly modelInfo: { model: string };
  readonly modelSpecifier: string;
  readonly inputMessages: ApiCallInputMessage[];
  readonly callStartTime: number;
  readonly logCalls: boolean;
  readonly metadata: Record<string, unknown> | undefined;
};

async function runBackground(
  responseId: string,
  createdAt: number,
  originalModel: string,
  body: CreateResponseBody,
  genParams: ReturnType<typeof buildGenerationParams>,
  include: IncludeValue[],
  outputConfig: ReturnType<typeof buildOutputConfig>,
  logFields: LogFields,
) {
  const toolCalls: ToolCallItem[] = [];
  const toolResults: ToolResultData[] = [];
  try {
    const result = await generateText({
      ...genParams,
      onStepFinish: createToolTracker(toolCalls, toolResults),
    });
    const responseText = resolveResponseText(result.text, () => result.output, outputConfig.usesStructuredOutput);
    const completedResponse = createResponseObject({
      responseId, createdAt, model: originalModel, status: "completed",
      output: buildOutputItems(responseId, responseText, toolCalls, toolResults, include),
      usage: result.usage, body,
    });
    await saveResponse(responseId, completedResponse);
    logChatUsage({
      ...logFields,
      usage: result.usage,
      outputData: { model: originalModel, choices: [{ index: 0, message: { role: "assistant", content: responseText } }] },
      stream: false,
    });
  } catch (error) {
    const failedResponse = markResponseFailed(
      createResponseObject({ responseId, createdAt, model: originalModel, status: "failed", body }),
      error instanceof Error ? error.message : "Gateway error",
    );
    await saveResponse(responseId, failedResponse)
      .catch((err) => log.error({ err, responseId }, "Failed to persist failed response"));
  }
}

// ---------------------------------------------------------------------------
// GET / DELETE /v1/responses/:responseId
// ---------------------------------------------------------------------------

export async function handleGetOrDeleteResponseRequest(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization") || "";
  const authCheckResponse = await checkAuth(authHeader);
  if (authCheckResponse instanceof Response) return authCheckResponse;

  const paramsId = (req as Request & { params?: { responseId?: string } }).params?.responseId;
  const pathId = new URL(req.url).pathname.split("/").filter(Boolean).at(-1);
  const responseId = paramsId ?? pathId;
  if (!responseId) return errorResponse("Not found", 404);

  if (req.method === "GET") {
    const stored = await getResponse(responseId);
    if (!stored) return errorResponse("Not found", 404);
    return Response.json(stored);
  }

  if (req.method === "DELETE") {
    await deleteResponse(responseId);
    return Response.json({ id: responseId, object: "response", deleted: true });
  }

  return errorResponse("Method Not found", 404);
}
