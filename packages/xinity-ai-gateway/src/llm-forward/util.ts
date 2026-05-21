import { logChatSync, logChatStream, type ChatSyncData, type ChatStreamData } from "../callLogger";
import { recordTokenUsage } from "../metrics";
import { recordUsageEvent } from "../usageRecorder";
import type { AuthResult } from "./auth";
import type { ModelMessage, ImagePart, TextPart } from "ai";
import type { ApiCallInputMessage } from "common-db";
import { BLOCKED_REQUEST_PARAM_PREFIXES } from "xinity-infoserver";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "util" });

// ---------------------------------------------------------------------------
// Message conversion (OpenAI wire format → AI SDK ModelMessage)
// ---------------------------------------------------------------------------

/**
 * Convert messages from OpenAI wire format to AI SDK ModelMessage format.
 *
 * Handles:
 * - `image_url` content parts → AI SDK `{ type: "image", image }` parts
 * - Assistant messages with `tool_calls` → AI SDK tool-call content parts
 * - `tool` role messages → AI SDK tool-result content parts
 */
export function toModelMessages(messages: ApiCallInputMessage[]): ModelMessage[] {
  // Build a toolCallId → toolName map from assistant messages so that
  // tool-result messages (which lack toolName in OpenAI format) can be mapped.
  const toolCallNameMap = new Map<string, string>();
  for (const msg of messages) {
    const raw = msg as Record<string, unknown>;
    if (raw.role === "assistant" && Array.isArray(raw.tool_calls)) {
      for (const tc of raw.tool_calls as Array<{ id?: string; function?: { name?: string } }>) {
        if (tc.id && tc.function?.name) toolCallNameMap.set(tc.id, tc.function.name);
      }
    }
  }

  return messages.map((msg) => {
    const raw = msg as Record<string, unknown>;

    // Assistant messages with tool_calls
    if (raw.role === "assistant" && Array.isArray(raw.tool_calls)) {
      const parts: Array<Record<string, unknown>> = [];
      // Preserve any text content alongside tool calls
      if (typeof raw.content === "string" && raw.content) {
        parts.push({ type: "text", text: raw.content });
      }
      for (const tc of raw.tool_calls as Array<{ id: string; type: string; function: { name: string; arguments: string } }>) {
        if (tc.type !== "function") continue;
        let args: unknown;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
        parts.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: args,
        });
      }
      return { role: "assistant", content: parts } as unknown as ModelMessage;
    }

    // Tool result messages
    if (raw.role === "tool" && typeof raw.tool_call_id === "string") {
      const resultValue = typeof raw.content === "string" ? raw.content : JSON.stringify(raw.content);
      return {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: raw.tool_call_id,
          toolName: toolCallNameMap.get(raw.tool_call_id as string) ?? "",
          output: { type: "text", value: resultValue },
        }],
      } as unknown as ModelMessage;
    }

    // Standard messages: convert image_url parts
    if (typeof msg.content === "string" || !Array.isArray(msg.content)) {
      return msg as ModelMessage;
    }
    const content = (msg.content as Array<{ type: string; text?: string; image_url?: { url: string } }>).flatMap<TextPart | ImagePart>((part) => {
      if (part.type !== "image_url" || !part.image_url) {
        return [part as TextPart];
      }
      // The AI SDK accepts data URIs and URL strings directly as image.image
      return [{ type: "image", image: part.image_url.url }];
    });
    return { ...msg, content } as ModelMessage;
  });
}

/** Usage data accepted from both AI SDK (inputTokens) and OpenAI wire format (prompt_tokens). */
export type UsageData = {
  inputTokens?: number;
  outputTokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

function normalizeInputTokens(usage: UsageData): number {
  return usage.inputTokens ?? usage.prompt_tokens ?? 0;
}

function normalizeOutputTokens(usage: UsageData): number {
  return usage.outputTokens ?? usage.completion_tokens ?? 0;
}

export type RecordUsageContext = {
  usage: UsageData | null | undefined;
  auth: AuthResult;
  modelInfo: { model: string };
  callStartTime: number;
  /**
   * Per-request override for whether the call body is stored:
   *   `undefined` defers to the API key's `collectData` policy,
   *   `true`/`false` ignore the policy and force the outcome.
   */
  logCalls?: boolean;
  /** The deployment's public specifier, used for per-deployment metrics. */
  deployment?: string;
};

/** Record token metrics and a usage event. Shared by all endpoint types. */
export const recordUsage = ({
  usage,
  auth,
  modelInfo,
  callStartTime,
  logCalls,
  deployment,
}: RecordUsageContext): boolean => {
  const durationMs = Date.now() - callStartTime;
  recordTokenUsage(modelInfo.model, auth.keyId, usage, { deployment, durationMs });
  if (!usage) {
    return false;
  }

  const shouldLog = logCalls ?? auth.collectData;

  recordUsageEvent({
    organizationId: auth.orgId,
    applicationId: auth.applicationId,
    apiKeyId: auth.keyId,
    model: modelInfo.model,
    inputTokens: normalizeInputTokens(usage),
    outputTokens: normalizeOutputTokens(usage),
    duration: durationMs,
    logged: shouldLog,
  });

  return shouldLog;
};

type UsageLogContextBase = {
  usage: UsageData | null | undefined;
  auth: AuthResult;
  modelInfo: { model: string };
  modelSpecifier: string;
  inputMessages: ApiCallInputMessage[];
  callStartTime: number;
  logCalls?: boolean;
  metadata?: Record<string, unknown>;
};

export type UsageLogContext = UsageLogContextBase & (
  | { stream: true; outputData: ChatStreamData }
  | { stream: false; outputData: ChatSyncData }
);

export const logChatUsage = ({
  usage,
  outputData,
  stream,
  auth,
  modelInfo,
  modelSpecifier,
  inputMessages,
  callStartTime,
  logCalls,
  metadata,
}: UsageLogContext) => {
  const shouldLog = recordUsage({ usage, auth, modelInfo, callStartTime, logCalls, deployment: modelSpecifier });
  if (!shouldLog) {
    return;
  }

  const commonFields = {
    keyId: auth.keyId,
    applicationId: auth.applicationId,
    organizationId: auth.orgId,
    modelSpecifier,
    durationInMS: Date.now() - callStartTime,
    inputMessages,
    metadata,
  };

  if (stream) {
    logChatStream({ ...commonFields, data: outputData }).catch((err) => {
      log.error({ err }, "logChatStream error");
    });
  } else {
    logChatSync({ ...commonFields, data: outputData }).catch((err) => {
      log.error({ err }, "logChatSync error");
    });
  }
};

// ---------------------------------------------------------------------------
// SSE streaming helpers
// ---------------------------------------------------------------------------

/** Standard headers for SSE streaming responses. */
export const SSE_RESPONSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
} as const;

/** Shared TextEncoder for SSE frame encoding. */
export const sseEncoder = new TextEncoder();

/**
 * Handles errors inside an OpenAI-compatible streaming ReadableStream.
 * Emits an error event + [DONE] sentinel and closes the controller.
 */
export function handleStreamError(
  e: unknown,
  controller: ReadableStreamDefaultController,
  log: { info: (obj: Record<string, unknown>, msg: string) => void; error: (obj: Record<string, unknown>, msg: string) => void },
): void {
  if (isAbortError(e)) {
    log.info({ err: e }, "Client disconnected during stream");
    try { controller.close(); } catch {}
    return;
  }
  log.error({ err: e }, "Stream error");
  try {
    controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify({ error: { message: "Internal stream error", type: "server_error" } })}\n\n`));
    controller.enqueue(sseEncoder.encode("data: [DONE]\n\n"));
    controller.close();
  } catch {
    try { controller.error(e as Error); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Returns a 400 error response with formatted Zod validation issues. */
export function validationError(error: { issues: { message: string }[] }): Response {
  return errorResponse(`Invalid request body: ${error.issues.map((i) => i.message).join(", ")}`, 400);
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

export async function* readSSEStream(response: Response) {
  if (!response.body) throw new Error("ReadableStream not available");

  let buffer = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let eventBoundary = buffer.indexOf("\n\n");
    while (eventBoundary !== -1) {
      const event = buffer.slice(0, eventBoundary);
      buffer = buffer.slice(eventBoundary + 2);

      yield processEvent(event);
      eventBoundary = buffer.indexOf("\n\n");
    }
  }
}

function parseSseField(line: string): { name: string; value: string } | null {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;
  return { name: line.slice(0, colonIdx), value: line.slice(colonIdx + 1).trim() };
}

export function processEvent(event: string): { eventType: string, id?: string, data: string } {
  let data = "";
  let eventType = "message";
  let id: string | undefined;

  for (const line of event.split("\n")) {
    const field = parseSseField(line);
    if (!field) continue;
    if (field.name === "data") data += field.value + "\n";
    else if (field.name === "event") eventType = field.value;
    else if (field.name === "id") id = field.value;
  }

  return { eventType, id, data: data.trim() };
}


// ---------------------------------------------------------------------------
// Request param passthrough extraction
// ---------------------------------------------------------------------------

const TYPE_VALIDATORS: Record<string, (v: unknown) => boolean> = {
  boolean: (v) => typeof v === "boolean",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  string: (v) => typeof v === "string",
};

function readAtDotPath(source: Record<string, unknown>, segments: string[]): unknown {
  let current: unknown = source;
  for (const seg of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

function writeAtDotPath(target: Record<string, unknown>, segments: string[], value: unknown): void {
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    if (!(key in cursor)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}

/**
 * Extracts allowed request-level parameters from a raw request body based on
 * the model's requestParams allowlist. Returns a nested object suitable for
 * merging into the fetch body, or undefined if nothing matched.
 *
 * Each entry in `allowedParams` is a dot-path (e.g. "chat_template_kwargs.enable_thinking")
 * mapped to a primitive type name ("boolean", "number", "string").
 */
export function extractAllowedRequestParams(
  rawBody: Record<string, unknown>,
  allowedParams: Record<string, string> | undefined,
): Record<string, unknown> | undefined {
  if (!allowedParams || Object.keys(allowedParams).length === 0) return undefined;

  let result: Record<string, unknown> | undefined;

  for (const [dotPath, typeName] of Object.entries(allowedParams)) {
    const segments = dotPath.split(".");
    if (BLOCKED_REQUEST_PARAM_PREFIXES.includes(segments[0]!)) continue;

    const validator = TYPE_VALIDATORS[typeName];
    if (!validator) continue;

    const value = readAtDotPath(rawBody, segments);
    if (value === undefined || !validator(value)) continue;

    if (!result) result = {};
    writeAtDotPath(result, segments, value);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Reliably detect AbortError / TimeoutError regardless of whether the runtime
 * throws a plain Error or a DOMException (Bun throws DOMException whose
 * `instanceof Error` can be false in some versions).
 */
function hasErrorName(e: unknown, name: string): boolean {
  return e != null && typeof e === "object" && "name" in e && (e as { name: unknown }).name === name;
}

export function isAbortError(e: unknown): boolean {
  return hasErrorName(e, "AbortError");
}

export function isTimeoutError(e: unknown): boolean {
  return hasErrorName(e, "TimeoutError");
}

function errorTypeFromStatus(status: number): string {
  switch (status) {
    case 401: return "authentication_error";
    case 403: return "permission_error";
    case 404: return "not_found_error";
    case 405: return "method_not_allowed";
    case 429: return "rate_limit_error";
    case 500:
    case 502: return "server_error";
    default: return "invalid_request_error";
  }
}

export function errorResponse(message: string, statusCode = 500, headers?: Record<string, string>) {
  return new Response(JSON.stringify({
    error: {
      message,
      type: errorTypeFromStatus(statusCode),
      param: null,
      code: null,
    },
  }), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function mapBackendStatusToClient(backendStatus: number): number {
  if (backendStatus < 500) return backendStatus;
  if (backendStatus === 503) return 503;
  return 502;
}

function isJsonString(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Handles a non-ok backend response. Forwards 4xx status codes as-is (e.g.
 * context length exceeded) and maps 5xx to 502 (actual bad gateway).
 */
export async function forwardBackendError(
  backendResponse: Response,
  log: { error: (obj: Record<string, unknown>, msg: string) => void },
): Promise<Response> {
  const text = await backendResponse.text().catch(() => "");
  log.error({ status: backendResponse.status, body: text }, "Backend error");
  const status = mapBackendStatusToClient(backendResponse.status);
  if (isJsonString(text)) {
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  }
  return errorResponse(text || "Bad Gateway", status);
}

/** Returns true when the error represents a refused/unreachable backend connection. */
export function isConnectionRefused(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === "ConnectionRefused";
}

export function isUpstreamError(error: unknown): error is Error {
  return error instanceof Error && (
    "statusCode" in error || "status" in error || error.name === "APICallError"
  );
}

/** Extracts the HTTP status from an upstream SDK error, falling back to 502 when absent or out of range. */
export function upstreamHttpStatus(error: unknown): number {
  if (!(error instanceof Error)) return 502;
  const raw = (error as unknown as { statusCode?: unknown; status?: unknown });
  const candidate = raw.statusCode ?? raw.status;
  return typeof candidate === "number" && candidate >= 400 && candidate < 600 ? candidate : 502;
}

/**
 * Returns a safe message to expose to the client.
 * Upstream errors carry meaningful messages (e.g. context length exceeded); anything else
 * could leak internals so it gets a generic label.
 */
export function clientFacingErrorMessage(error: unknown): string {
  return isUpstreamError(error) ? error.message : "Gateway error";
}

/**
 * True when the model has a tag list that does not include "tools" — i.e. the catalog
 * knows the model and it's marked as lacking tool-use support. Unknown tags (undefined)
 * are treated as "may support tools" to avoid blocking on missing catalog data.
 */
export function modelLacksToolSupport(modelInfo: { tags?: string[] }): boolean {
  return modelInfo.tags !== undefined && !modelInfo.tags.includes("tools");
}

/** Seconds to advertise in Retry-After when a backend node is unreachable (covers typical vLLM restart time). */
export const BACKEND_RESTART_RETRY_AFTER = 120;

/**
 * Shared top-level error handler for endpoint catch blocks.
 * Maps common fetch errors to appropriate HTTP status codes.
 */
export function handleEndpointError(
  error: unknown,
  log: { info: (obj: Record<string, unknown>, msg: string) => void; warn: (obj: Record<string, unknown>, msg: string) => void; error: (obj: Record<string, unknown>, msg: string) => void },
): Response {
  if (isAbortError(error)) {
    log.info({ err: error }, "Client disconnected");
    return new Response(null, { status: 499 });
  }
  if (isTimeoutError(error)) {
    log.warn({ err: error }, "Backend timeout");
    return errorResponse("Backend timeout", 504);
  }
  if (isConnectionRefused(error)) {
    log.warn({ err: error }, "Backend unreachable");
    return errorResponse(
      "Service temporarily unavailable. Consider adding cluster capacity",
      503,
      { "Retry-After": String(BACKEND_RESTART_RETRY_AFTER) },
    );
  }
  log.error({ err: error }, "Internal gateway error");
  // Generic message: error.message can include DB/SDK internals that must not
  // reach the client. Full error is logged above for debugging.
  return errorResponse("Internal Server Error", 500);
}

export function validateModelType(
  modelInfo: { type?: string },
  expectedTypes: string[],
): Response | null {
  if (modelInfo.type && !expectedTypes.includes(modelInfo.type)) {
    return errorResponse(
      `Model type "${modelInfo.type}" is not supported for this endpoint. Expected: ${expectedTypes.join(", ")}`,
      400,
    );
  }
  return null;
}