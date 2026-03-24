import { logChatSync, logChatStream, type ChatSyncData, type ChatStreamData } from "../callLogger";
import { recordTokenUsage } from "../metrics";
import { recordUsageEvent } from "../usageRecorder";
import type { AuthResult } from "./auth";
import type { ModelMessage, ImagePart, TextPart } from "ai";
import type { ApiCallInputMessage } from "common-db";
import { BLOCKED_REQUEST_PARAM_PREFIXES } from "xinity-infoserver";

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
  logCalls?: boolean;
};

/** Record token metrics and a usage event. Shared by all endpoint types. */
export const recordUsage = ({
  usage,
  auth,
  modelInfo,
  callStartTime,
  logCalls = true,
}: RecordUsageContext): boolean => {
  recordTokenUsage(modelInfo.model, auth.keyId, usage);
  if (!usage) return false;

  const shouldLog = auth.collectData && logCalls;

  recordUsageEvent({
    organizationId: auth.orgId,
    applicationId: auth.applicationId,
    apiKeyId: auth.keyId,
    model: modelInfo.model,
    inputTokens: normalizeInputTokens(usage),
    outputTokens: normalizeOutputTokens(usage),
    duration: Date.now() - callStartTime,
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
  logCalls = true,
  metadata,
}: UsageLogContext) => {
  const shouldLog = recordUsage({ usage, auth, modelInfo, callStartTime, logCalls });
  if (!shouldLog) return;

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
    logChatStream({
      ...commonFields,
      data: outputData,
    });
  } else {
    logChatSync({
      ...commonFields,
      data: outputData,
    });
  }
};

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

      yield processEvent(event); // Process event
      eventBoundary = buffer.indexOf("\n\n");
    }
  }
}

export function processEvent(event: string): { eventType: string, id?: string, data: string } {
  const lines = event.split("\n");
  let data = "";
  let eventType = "message";
  let id: string | undefined;

  for (const line of lines) {
    if (line.startsWith("data:")) {
      data += line.slice(5).trim() + "\n";
    } else if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    }
  }

  return {
    eventType,
    id,
    data: data.trim(),
  }
}


// ---------------------------------------------------------------------------
// Request param passthrough extraction
// ---------------------------------------------------------------------------

const TYPE_VALIDATORS: Record<string, (v: unknown) => boolean> = {
  boolean: (v) => typeof v === "boolean",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  string: (v) => typeof v === "string",
};

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
  allowedParams: Record<string, string>,
): Record<string, unknown> | undefined {
  if (!allowedParams || Object.keys(allowedParams).length === 0) return undefined;

  let result: Record<string, unknown> | undefined;

  for (const [dotPath, typeName] of Object.entries(allowedParams)) {
    // Defense in depth: skip blocked prefixes even if they made it past schema validation
    const topLevel = dotPath.split(".")[0];
    if (BLOCKED_REQUEST_PARAM_PREFIXES.some(prefix => topLevel === prefix)) continue;

    const validator = TYPE_VALIDATORS[typeName];
    if (!validator) continue;

    // Walk the raw body to extract the value at the dot-path
    const segments = dotPath.split(".");
    let current: unknown = rawBody;
    let found = true;
    for (const seg of segments) {
      if (current == null || typeof current !== "object") { found = false; break; }
      current = (current as Record<string, unknown>)[seg];
    }

    if (!found || current === undefined) continue;
    if (!validator(current)) continue;

    // Build the nested result object
    if (!result) result = {};
    let target = result;
    for (let i = 0; i < segments.length - 1; i++) {
      const key = segments[i]!;
      if (!(key in target)) target[key] = {};
      target = target[key] as Record<string, unknown>;
    }
    target[segments[segments.length - 1]!] = current;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

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

export function errorResponse(message: string, statusCode = 500) {
  return new Response(JSON.stringify({
    error: {
      message,
      type: errorTypeFromStatus(statusCode),
      param: null,
      code: null,
    },
  }), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  });
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
  const status = backendResponse.status >= 500 ? 502 : backendResponse.status;
  try {
    JSON.parse(text);
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  } catch {
    return errorResponse(text || "Bad Gateway", status);
  }
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