import { mock, jest } from "bun:test";
import { MOCK_GATEWAY_ENV } from "../mock-env";
import type { getModelInfo as getModelInfoT } from "../model-data";

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
    hasCustomCa: false,
  }));
}

export function setupResponseTestMocks() {
  mock.module("../../env", () => ({ env: { ...MOCK_GATEWAY_ENV } }));

  const checkAuth = jest.fn(async () => ({
    orgId: "org-1",
    keyId: "key-1",
    applicationId: "app-1",
    collectData: true,
  }));
  mock.module("../auth", () => ({ checkAuth }));

  let mockPort = 0;
  const getModelInfo = jest.fn<typeof getModelInfoT>(async () => ({
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
  const saveResponse = jest.fn(async (_orgId: string, id: string, payload: any) => {
    responseStore.set(id, payload);
  });
  const getResponse = jest.fn(async (_orgId: string, id: string) => responseStore.get(id) ?? null);
  const deleteResponse = jest.fn(async (_orgId: string, id: string) => {
    responseStore.delete(id);
    return true;
  });
  mock.module("../response-store", () => ({ saveResponse, getResponse, deleteResponse }));

  const logChatSync = jest.fn(async () => {});
  const logChatStream = jest.fn(async () => {});
  mock.module("../../callLogger", () => ({ logChatSync, logChatStream }));
  mock.module("../../usageRecorder", () => ({ recordUsageEvent: mock(() => {}) }));

  return {
    checkAuth,
    getModelInfo,
    responseStore,
    saveResponse,
    getResponse,
    deleteResponse,
    logChatSync,
    logChatStream,
    setMockPort(port: number) { mockPort = port; },
    clearAll() {
      checkAuth.mockClear();
      getModelInfo.mockClear();
      saveResponse.mockClear();
      getResponse.mockClear();
      deleteResponse.mockClear();
      logChatSync.mockClear();
      logChatStream.mockClear();
      responseStore.clear();
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
