import { mock, jest } from "bun:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { getModelInfo as getModelInfoT, ModelInfo, ModelLookup } from "../model-data";
import { outputAsMessages } from "../responses/input-normalize";

export function modelFound(info: ModelInfo): ModelLookup {
  return { status: "found", info };
}

/**
 * OpenAI-compliant mock upstream response helpers for unit tests.
 *
 * A proper chat completion SSE stream must contain:
 *   1. Role announcement chunk  (delta: { role, content: "" })
 *   2. One or more content delta chunks
 *   3. Finish chunk  (delta: {}, finish_reason: "stop")
 *   4. data: [DONE]
 */

const MOCK_ID = "test-id";
const MOCK_CREATED = 123;

const SSE_HEADERS = { "Content-Type": "text/event-stream" };

function chatCompletionEnvelope(model: string) {
  return { id: MOCK_ID, object: "chat.completion", created: MOCK_CREATED, model };
}

function sseResponse(body: string): Response {
  return new Response(body, { headers: SSE_HEADERS });
}

type MockUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens: number };
};

function sseChunk(
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: MockUsage,
): string {
  const obj: Record<string, unknown> = {
    id: MOCK_ID,
    object: "chat.completion.chunk",
    created: MOCK_CREATED,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) obj.usage = usage;
  return "data: " + JSON.stringify(obj) + "\n\n";
}

const MOCK_USAGE = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 };

/** Builds a proper OpenAI-compliant SSE body for a chat completion stream. */
export function makeChatSseBody(model: string, contentChunks: string[]): string {
  return [
    sseChunk(model, { role: "assistant", content: "" }),
    ...contentChunks.map((c) => sseChunk(model, { content: c })),
    sseChunk(model, {}, "stop", MOCK_USAGE),
    "data: [DONE]\n\n",
  ].join("");
}

export const SSE_PROMPT_TOKENS = 5;

function cumulativeUsage(completionTokens: number): MockUsage {
  return { prompt_tokens: SSE_PROMPT_TOKENS, completion_tokens: completionTokens, total_tokens: SSE_PROMPT_TOKENS + completionTokens };
}

function sseUsageOnlyChunk(model: string, usage: MockUsage): string {
  return "data: " + JSON.stringify({ ...chatCompletionEnvelope(model), object: "chat.completion.chunk", choices: [], usage }) + "\n\n";
}

/**
 * SSE events as vLLM sends them with `continuous_usage_stats`: content chunk i carries the
 * cumulative usage of its choice (completion_tokens = i + 1), then a finish chunk. With
 * `finalUsageChunk`, a usage-only chunk (choices: []) follows. No [DONE].
 */
export function makeChatSseChunksWithUsage(
  model: string,
  contentChunks: string[],
  { finalUsageChunk = false }: { finalUsageChunk?: boolean } = {},
): string[] {
  const finalUsage = cumulativeUsage(contentChunks.length);
  return [
    ...contentChunks.map((c, i) => sseChunk(model, { content: c }, null, cumulativeUsage(i + 1))),
    sseChunk(model, {}, "stop", finalUsage),
    ...(finalUsageChunk ? [sseUsageOnlyChunk(model, finalUsage)] : []),
  ];
}

/** The events of `makeChatSseChunksWithUsage` as one complete body, ending in [DONE]. */
export function makeChatSseBodyWithUsage(
  model: string,
  contentChunks: string[],
  options: { finalUsageChunk?: boolean } = {},
): string {
  return [...makeChatSseChunksWithUsage(model, contentChunks, options), "data: [DONE]\n\n"].join("");
}

/**
 * How a controlled stream ends after its chunks. "abort" and "timeout" error the stream, which
 * escapes Bun.serve on Linux, so only a Response built in the test can use them.
 */
export type SseStreamEnd = "done" | "cut" | "abort" | "timeout" | "hold";

/**
 * A backend SSE body that sends `chunks`, then ends with `end`. With `gateAfter: n`, chunk n+1
 * and later chunks wait until the test calls `release()`.
 */
export function makeControlledSseStream(
  chunks: string[],
  end: SseStreamEnd,
  { gateAfter }: { gateAfter?: number } = {},
): { stream: ReadableStream<Uint8Array>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const encoder = new TextEncoder();
  let next = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next < chunks.length) {
        if (next === gateAfter) {
          await gate;
        }
        controller.enqueue(encoder.encode(chunks[next++]!));
        return;
      }
      switch (end) {
        case "done":
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        case "cut":
          controller.close();
          return;
        case "abort":
          controller.error(new DOMException("aborted", "AbortError"));
          return;
        case "timeout":
          controller.error(new DOMException("timed out", "TimeoutError"));
          return;
        case "hold":
          await new Promise(() => {});
      }
    },
  });
  return { stream, release };
}

/**
 * A backend that holds a request until the gateway leaves. "headers": it does not answer.
 * "body": it sends the headers and part of a JSON body. `reached` resolves when the gateway
 * waits in that state, so the test can abort the client request then.
 */
export function makeHoldingBackend(stage: "headers" | "body"): {
  handle: (req: Request) => Promise<Response>;
  reached: Promise<void>;
} {
  let markReached!: () => void;
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  return {
    reached,
    async handle(req) {
      if (stage === "headers") {
        markReached();
        await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true }));
        return new Response(null, { status: 503 });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          // Gives the gateway time to receive the headers and start to read the body.
          setTimeout(markReached, 30);
        },
      });
      return new Response(body, { headers: { "Content-Type": "application/json" } });
    },
  };
}

export function makeChatSseResponse(model: string, contentChunks: string[]): Response {
  return sseResponse(makeChatSseBody(model, contentChunks));
}

export function makeChatJsonResponse(
  model: string,
  content: string,
  usage = { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 },
): Response {
  return Response.json({
    ...chatCompletionEnvelope(model),
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage,
  });
}

// ---------------------------------------------------------------------------
// Reasoning mock responses
// ---------------------------------------------------------------------------

export const MOCK_REASONING_TOKENS = 7;

const MOCK_REASONING_USAGE: MockUsage = {
  prompt_tokens: 5,
  completion_tokens: 12,
  total_tokens: 17,
  completion_tokens_details: { reasoning_tokens: MOCK_REASONING_TOKENS },
};

/** Non-streaming upstream response carrying vLLM-style `reasoning_content`. */
export function makeChatJsonResponseWithReasoning(
  model: string,
  content: string,
  reasoning: string,
): Response {
  return Response.json({
    ...chatCompletionEnvelope(model),
    choices: [{
      index: 0,
      message: { role: "assistant", content, reasoning_content: reasoning },
      finish_reason: "stop",
    }],
    usage: MOCK_REASONING_USAGE,
  });
}

/** Streaming upstream response emitting `reasoning_content` deltas ahead of the content. */
export function makeChatSseResponseWithReasoning(
  model: string,
  contentChunks: string[],
  reasoningChunks: string[],
): Response {
  return sseResponse([
    sseChunk(model, { role: "assistant", content: "" }),
    ...reasoningChunks.map((r) => sseChunk(model, { reasoning_content: r })),
    ...contentChunks.map((c) => sseChunk(model, { content: c })),
    sseChunk(model, {}, "stop", MOCK_REASONING_USAGE),
    "data: [DONE]\n\n",
  ].join(""));
}

// ---------------------------------------------------------------------------
// Tool call mock responses
// ---------------------------------------------------------------------------

type MockToolCall = { id: string; name: string; arguments: string };

/** Non-streaming upstream response with tool calls. */
export function makeChatJsonResponseWithToolCalls(
  model: string,
  toolCalls: MockToolCall[],
  usage = { total_tokens: 15, prompt_tokens: 10, completion_tokens: 5 },
): Response {
  return Response.json({
    ...chatCompletionEnvelope(model),
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      },
      finish_reason: "tool_calls",
    }],
    usage,
  });
}

/** SSE body for a streaming upstream response with tool calls. */
export function makeChatSseBodyWithToolCalls(
  model: string,
  toolCalls: MockToolCall[],
): string {
  const chunks: string[] = [
    sseChunk(model, { role: "assistant", content: null }),
  ];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!;
    chunks.push(sseChunk(model, {
      tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.name, arguments: "" } }],
    }));
    chunks.push(sseChunk(model, {
      tool_calls: [{ index: i, function: { arguments: tc.arguments } }],
    }));
  }
  chunks.push(sseChunk(model, {}, "tool_calls"));
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

/** Streaming upstream response with tool calls. */
export function makeChatSseResponseWithToolCalls(
  model: string,
  toolCalls: MockToolCall[],
): Response {
  return sseResponse(makeChatSseBodyWithToolCalls(model, toolCalls));
}

/** Builds a raw JSON response with arbitrary body, for testing schema resilience. */
export function makeRawJsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// Must export the full backend-fetch surface: bun's mock.module is process-global,
// so a partial mock leaks into later test files and breaks their imports.
export function mockBackendFetch(): void {
  mock.module("../backend-fetch", () => ({
    backendUrl: (host: string, _model: string, path: string) => `http://${host}${path}`,
    backendFetch: (url: string | URL | Request, init?: RequestInit) => fetch(url, init),
    backendPostForm: (target: { host: string }, path: string, form: FormData, signal: AbortSignal) =>
      fetch(`http://${target.host}${path}`, { method: "POST", body: form, signal }),
    backendPostJson: (target: { host: string }, path: string, body: unknown, signal: AbortSignal) =>
      fetch(`http://${target.host}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    createIdleTimeout: () => ({ signal: new AbortController().signal, reset: () => {}, clear: () => {} }),
    nodeProvider: (target: { host: string; driver: string }) =>
      createOpenAICompatible({ name: target.driver, baseURL: `http://${target.host}/v1`, includeUsage: true }),
  }));
}

export function setupResponseTestMocks() {

  const checkAuth = jest.fn(async () => ({
    orgId: "org-1",
    keyId: "key-1",
    applicationId: "app-1",
    collectData: true,
  }));
  mock.module("../auth", () => ({ checkAuth }));

  let mockPort = 0;
  const getModelInfo = jest.fn<typeof getModelInfoT>(async () => modelFound({
    installationId: "inst-1",
    nodeId: "node-1",
    host: `localhost:${mockPort}`,
    specifier: "test-model",
    model: "test-model",
    driver: "vllm",
    authToken: null,
    tls: false,
    tags: ["tools"],
    requestParams: {},
    maxContextLength: 131072,
    release: () => {},
  }));
  mock.module("../model-data", () => ({ getModelInfo }));

  const responseStore = new Map<string, any>();
  /** Stands in for api_response_message: what each response was asked, not what it answered. */
  const responseMessages = new Map<string, any[]>();
  const saveResponse = jest.fn(async (_orgId: string, id: string, payload: any, creation?: any) => {
    responseStore.set(id, payload);
    if (creation?.inputMessages) {
      responseMessages.set(id, [...creation.inputMessages]);
    }
    // Settling appends the reply, the way persistence does, so a chained turn reads it back.
    if (payload?.status && payload.status !== "in_progress") {
      responseMessages.get(id)?.push(...outputAsMessages(payload));
    }
  });
  const getResponse = jest.fn(async (_orgId: string, id: string) => responseStore.get(id) ?? null);
  const getResponseMessages = jest.fn(async (_orgId: string, id: string) => responseMessages.get(id) ?? []);
  const deleteResponse = jest.fn(async (_orgId: string, id: string) => {
    responseStore.delete(id);
    responseMessages.delete(id);
    return true;
  });
  mock.module("../response-store", () => ({ saveResponse, getResponse, getResponseMessages, deleteResponse }));

  const logChatSync = jest.fn(async () => {});
  const logChatStream = jest.fn(async () => {});
  mock.module("../../callLogger", () => ({ logChatSync, logChatStream }));
  const recordUsageEvent = jest.fn((_record: Record<string, unknown>) => {});
  mock.module("../../usageRecorder", () => ({ recordUsageEvent }));

  return {
    checkAuth,
    getModelInfo,
    responseStore,
    responseMessages,
    saveResponse,
    getResponse,
    getResponseMessages,
    deleteResponse,
    logChatSync,
    logChatStream,
    recordUsageEvent,
    setMockPort(port: number) { mockPort = port; },
    clearAll() {
      checkAuth.mockClear();
      getModelInfo.mockClear();
      saveResponse.mockClear();
      getResponse.mockClear();
      getResponseMessages.mockClear();
      deleteResponse.mockClear();
      logChatSync.mockClear();
      logChatStream.mockClear();
      recordUsageEvent.mockClear();
      responseStore.clear();
      responseMessages.clear();
    },
  };
}

export function requestWithParams(req: Request, params: Record<string, string>): Request {
  (req as Request & { params: Record<string, string> }).params = params;
  return req;
}

export async function waitForResponseStatus(
  responseStore: Map<string, any>,
  responseId: string,
  status: string,
  timeoutMs = 2000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stored = responseStore.get(responseId);
    if (stored?.status === status) return stored;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return null;
}

/**
 * Reasoning interrupted by content and resumed after. The provider closes a block on the
 * first content delta and opens a new one for the later reasoning, so this shape is what
 * a response holding several reasoning items looks like on the wire.
 */
export function makeChatSseResponseWithInterleavedReasoning(model: string): Response {
  return sseResponse([
    sseChunk(model, { role: "assistant", content: "" }),
    sseChunk(model, { reasoning_content: "first block" }),
    sseChunk(model, { content: "Hello" }),
    sseChunk(model, { reasoning_content: "second block" }),
    sseChunk(model, {}, "stop", MOCK_REASONING_USAGE),
    "data: [DONE]\n\n",
  ].join(""));
}
