import { recordBackendError } from "../metrics";
import { BLOCKED_REQUEST_PARAM_PREFIXES } from "xinity-infoserver";
import { isImageTooLarge } from "../image-store";

export { toModelMessages } from "./message-convert";
export { recordUsage, recordFailedRequest, logChatUsage } from "./usage";
export type { UsageData, RecordUsageContext, FailedRequestContext, UsageLogContext } from "./usage";

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

export type StreamErrorInfo = {
  /** Safe to hand to the client. */
  message: string;
  errorType: string;
  logLevel: "warn" | "error";
  logMessage: string;
};

/** Classifies without logging, so each stream can log with its own context. */
export function classifyStreamError(e: unknown): StreamErrorInfo {
  if (isTimeoutError(e)) {
    return {
      message: "Backend timed out while generating the response",
      errorType: "timeout_error",
      logLevel: "warn",
      logMessage: "Backend timeout during stream",
    };
  }
  if (isConnectionRefused(e)) {
    return {
      message: "Service temporarily unavailable",
      errorType: "server_error",
      logLevel: "warn",
      logMessage: "Backend unreachable during stream",
    };
  }
  if (isUpstreamError(e)) {
    return {
      message: clientFacingErrorMessage(e),
      errorType: "server_error",
      logLevel: "error",
      logMessage: "Upstream error during stream",
    };
  }
  return {
    message: "Internal server error",
    errorType: "server_error",
    logLevel: "error",
    logMessage: "Internal error during stream",
  };
}

/**
 * Handles errors inside an OpenAI-compatible streaming ReadableStream.
 * Emits an error event + [DONE] sentinel and closes the controller.
 */
export function handleStreamError(
  e: unknown,
  controller: ReadableStreamDefaultController,
  log: { info: (obj: Record<string, unknown>, msg: string) => void; warn?: (obj: Record<string, unknown>, msg: string) => void; error: (obj: Record<string, unknown>, msg: string) => void },
): void {
  if (isAbortError(e)) {
    log.info({ err: e }, "Client disconnected during stream");
    try { controller.close(); } catch {}
    return;
  }

  const { message, errorType, logLevel, logMessage } = classifyStreamError(e);
  (logLevel === "warn" ? log.warn ?? log.error : log.error)({ err: e }, logMessage);

  try {
    controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify({ error: { message, type: errorType } })}\n\n`));
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
    buffer += decoder.decode(value, { stream: !done });
    if (done) break;

    let eventBoundary = buffer.indexOf("\n\n");
    while (eventBoundary !== -1) {
      const event = buffer.slice(0, eventBoundary);
      buffer = buffer.slice(eventBoundary + 2);

      yield processEvent(event);
      eventBoundary = buffer.indexOf("\n\n");
    }
  }

  // Emit a final event the upstream left unterminated before closing.
  if (buffer.trim().length > 0) yield processEvent(buffer);
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
  const leaf = segments.at(-1);
  if (leaf === undefined) return;
  const ancestors = segments.slice(0, -1);
  let cursor = target;
  for (const key of ancestors) {
    if (!(key in cursor)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[leaf] = value;
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
    if (BLOCKED_REQUEST_PARAM_PREFIXES.includes(segments[0] ?? "")) continue;

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
  if (hasErrorName(e, "TimeoutError")) return true;
  if (e != null && typeof e === "object" && "cause" in e) {
    return isTimeoutError((e as { cause: unknown }).cause);
  }
  return false;
}

function errorTypeFromStatus(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 405) return "method_not_allowed";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
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
  model?: string,
): Promise<Response> {
  const text = await backendResponse.text().catch(() => "");
  log.error({ status: backendResponse.status, body: text }, "Backend error");
  if (model) recordBackendError(model, backendResponse.status);
  const status = mapBackendStatusToClient(backendResponse.status);
  if (backendResponse.status >= 500) {
    return errorResponse("Bad Gateway", status);
  }
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
  if (isImageTooLarge(error)) {
    log.warn({ err: error }, "Image rejected at ingest");
    return errorResponse((error as Error).message, 413);
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