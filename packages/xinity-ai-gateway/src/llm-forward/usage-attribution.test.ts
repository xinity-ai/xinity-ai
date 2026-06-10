import { describe, test, expect, mock, beforeAll, afterAll, afterEach, jest } from "bun:test";
import { makeChatSseResponse, makeChatJsonResponse } from "./endpoints/test-helpers";

mock.module("../env", () => ({
  env: {
    HOST: "localhost",
    PORT: 4010,
    DB_CONNECTION_URL: "postgresql://localhost/test",
    REDIS_URL: "redis://localhost:6379",
    WEB_SEARCH_ENGINE_URL: undefined,
    RESPONSE_CACHE_TTL_SECONDS: 3600,
    INFOSERVER_URL: "http://localhost:3000",
    INFOSERVER_CACHE_TTL_MS: 30000,
    LOAD_BALANCE_STRATEGY: "random",
    BACKEND_TIMEOUT_MS: 300000,
    LOG_LEVEL: "info",
    LOG_DIR: undefined,
    METRICS_AUTH: undefined,
  },
}));

import type { checkAuth as checkAuthT } from "./auth";
import type { getModelInfo as getModelInfoT } from "./model-data";

const checkAuth = jest.fn<typeof checkAuthT>(async () => ({
  orgId: "org-1",
  keyId: "key-1",
  applicationId: "app-1",
  collectData: false,
}));
mock.module("./auth", () => ({ checkAuth }));

let mockPort = 0;
const getModelInfo = jest.fn<typeof getModelInfoT>(async () => ({
  nodeId: "node-1",
  host: `localhost:${mockPort}`,
  model: "test-model",
  driver: "vllm",
  authToken: null,
  tls: false,
  tags: ["tools"],
  requestParams: {},
  release: () => {},
}));
mock.module("./model-data", () => ({ getModelInfo }));

mock.module("./backend-fetch", () => ({
  backendUrl: (host: string, _model: string, path: string, _tls: boolean) => `http://${host}${path}`,
  backendFetch: (url: string | URL | Request, init?: RequestInit) => fetch(url, init),
  backendPostJson: (target: { host: string }, path: string, body: unknown, clientSignal: AbortSignal) =>
    fetch(`http://${target.host}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: clientSignal,
    }),
  hasCustomCa: false,
}));

mock.module("../callLogger", () => ({
  logChatStream: mock(() => Promise.resolve()),
  logChatSync: mock(() => Promise.resolve()),
}));

const recordUsageEvent = mock((_record: Record<string, unknown>) => {});
mock.module("../usageRecorder", () => ({ recordUsageEvent }));

const { handleChatCompletion } = await import("./endpoints/handle-chatCompletion");

let nextUpstreamResponse: (() => Response) | null = null;
let server: any;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      if (nextUpstreamResponse) {
        const make = nextUpstreamResponse;
        nextUpstreamResponse = null;
        return make();
      }
      return makeChatJsonResponse("test-model", "Hello");
    },
  });
  mockPort = server.port;
});

afterEach(() => {
  recordUsageEvent.mockClear();
  getModelInfo.mockClear();
  nextUpstreamResponse = null;
});

afterAll(() => {
  server.stop(true);
});

function chatRequest(body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost:4000/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer test" },
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
      ...body,
    }),
  });
}

function lastUsageEvent(): Record<string, unknown> {
  expect(recordUsageEvent).toHaveBeenCalledTimes(1);
  return recordUsageEvent.mock.calls[0]![0] as Record<string, unknown>;
}

describe("usage event node attribution", () => {
  test("successful non-stream request records nodeId and success", async () => {
    const res = await handleChatCompletion(chatRequest());
    expect(res.status).toBe(200);
    await res.text();

    const event = lastUsageEvent();
    expect(event.nodeId).toBe("node-1");
    expect(event.success).toBe(true);
    expect(event.inputTokens).toBe(5);
    expect(event.outputTokens).toBe(5);
  });

  test("successful stream request records nodeId and success", async () => {
    nextUpstreamResponse = () => makeChatSseResponse("test-model", ["Hello"]);
    const res = await handleChatCompletion(chatRequest({ stream: true }));
    expect(res.status).toBe(200);
    await res.text();

    const event = lastUsageEvent();
    expect(event.nodeId).toBe("node-1");
    expect(event.success).toBe(true);
  });

  test("backend error records a failed event with node attribution", async () => {
    nextUpstreamResponse = () => new Response("boom", { status: 500 });
    const res = await handleChatCompletion(chatRequest());
    expect(res.status).toBe(502);

    const event = lastUsageEvent();
    expect(event.nodeId).toBe("node-1");
    expect(event.success).toBe(false);
    expect(event.inputTokens).toBe(0);
    expect(event.outputTokens).toBe(0);
  });

  test("validation error after node selection records a failed event", async () => {
    const res = await handleChatCompletion(chatRequest({ messages: "not-an-array" }));
    expect(res.status).toBe(400);

    const event = lastUsageEvent();
    expect(event.nodeId).toBe("node-1");
    expect(event.success).toBe(false);
  });

  test("mid-stream backend failure records a failed event", async () => {
    nextUpstreamResponse = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n'));
            controller.error(new Error("upstream died"));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );

    const res = await handleChatCompletion(chatRequest({ stream: true }));
    expect(res.status).toBe(200);
    await res.text();

    const event = lastUsageEvent();
    expect(event.nodeId).toBe("node-1");
    expect(event.success).toBe(false);
  });

  test("no usage event when the model is not found (no node selected)", async () => {
    getModelInfo.mockImplementationOnce(async () => undefined);
    const res = await handleChatCompletion(chatRequest());
    expect(res.status).toBe(404);
    expect(recordUsageEvent).not.toHaveBeenCalled();
  });
});
