import { describe, test, expect, mock, beforeAll, afterAll, jest, afterEach } from "bun:test";
import { makeRawJsonResponse } from "./test-helpers";

mock.module("../../env", () => ({
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

import type { checkAuth as checkAuthT } from "../auth";
import type { getModelInfo as getModelInfoT } from "../model-data";

const checkAuth = jest.fn<typeof checkAuthT>(async () => ({
  orgId: "org-1",
  keyId: "key-1",
  applicationId: "app-1",
  collectData: true,
}));

mock.module("../auth", () => ({
  checkAuth,
}));

let mockPort = 0;
const getModelInfo = jest.fn<typeof getModelInfoT>(async () => ({
  host: `localhost:${mockPort}`,
  model: "test-model",
  driver: "vllm",
  tags: [],
  requestParams: {},
  release: () => {},
}));

mock.module("../model-data", () => ({
  getModelInfo,
}));

const mockLogChatStream = mock(() => {});
const mockLogChatSync = mock(() => {});

mock.module("../../callLogger", () => ({
  logChatStream: mockLogChatStream,
  logChatSync: mockLogChatSync,
}));

mock.module("../../usageRecorder", () => ({
  recordUsageEvent: mock(() => {}),
}));

const { handleCompletion } = await import("./handle-completions");

// Helpers for completions-format responses
const MOCK_ID = "cmpl-test";
const MOCK_CREATED = 123;

function makeCompletionSseResponse(model: string, textChunks: string[]): Response {
  const chunks = [
    ...textChunks.map((t) =>
      "data: " + JSON.stringify({
        id: MOCK_ID, object: "text_completion", created: MOCK_CREATED, model,
        choices: [{ index: 0, text: t, logprobs: null, finish_reason: null }],
      }) + "\n\n"
    ),
    "data: " + JSON.stringify({
      id: MOCK_ID, object: "text_completion", created: MOCK_CREATED, model,
      choices: [{ index: 0, text: "", logprobs: null, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }) + "\n\n",
    "data: [DONE]\n\n",
  ];
  return new Response(chunks.join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function makeCompletionJsonResponse(model: string, text: string): Response {
  return Response.json({
    id: MOCK_ID, object: "text_completion", created: MOCK_CREATED, model,
    choices: [{ index: 0, text, logprobs: null, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  });
}

let server: ReturnType<typeof Bun.serve>;
let nextUpstreamResponse: Response | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/completions") {
        if (nextUpstreamResponse) {
          const r = nextUpstreamResponse;
          nextUpstreamResponse = null;
          return r;
        }
        const body = (await req.json()) as { stream?: boolean };
        if (body.stream) return makeCompletionSseResponse("test-model", ["Hello"]);
        return makeCompletionJsonResponse("test-model", "Hello");
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  mockPort = server.port!;
});

afterEach(() => {
  checkAuth.mockClear();
  getModelInfo.mockClear();
  mockLogChatStream.mockClear();
  mockLogChatSync.mockClear();
  nextUpstreamResponse = null;
});

afterAll(() => {
  server.stop();
});

describe("handleCompletion", () => {
  test("should handle streaming completion", async () => {
    const req = new Request("http://localhost:4000/v1/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        prompt: "Hi",
        stream: true,
      }),
    });

    const res = await handleCompletion(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await res.text();
    expect(text).toContain('"object":"text_completion"');
    expect(text).toContain('"text":"Hello"');
    expect(text).toContain("data: [DONE]");
  });

  test("should handle non-streaming completion", async () => {
    const req = new Request("http://localhost:4000/v1/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        prompt: "Hi",
        stream: false,
      }),
    });

    const res = await handleCompletion(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.object).toBe("text_completion");
    expect(body.choices?.[0]?.text).toBe("Hello");
  });

  test("should skip call logging when store is false", async () => {
    const req = new Request("http://localhost:4000/v1/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        prompt: "Hi",
        stream: false,
        store: false,
      }),
    });

    const res = await handleCompletion(req);
    expect(res.status).toBe(200);
    expect(mockLogChatSync).not.toHaveBeenCalled();
  });

  test("should forward 4xx from upstream as-is", async () => {
    nextUpstreamResponse = new Response(
      JSON.stringify({ error: { message: "Context length exceeded", type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );

    const req = new Request("http://localhost:4000/v1/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "test-model", prompt: "Hi" }),
    });

    const res = await handleCompletion(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("Context length exceeded");
  });

  test("should map 5xx from upstream to 502", async () => {
    nextUpstreamResponse = new Response("Internal Server Error", { status: 500 });

    const req = new Request("http://localhost:4000/v1/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "test-model", prompt: "Hi" }),
    });

    const res = await handleCompletion(req);
    expect(res.status).toBe(502);
  });

  test("should return 404 when model is not found", async () => {
    getModelInfo.mockImplementationOnce(async () => undefined);

    const req = new Request("http://localhost:4000/v1/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "nonexistent", prompt: "Hi" }),
    });

    const res = await handleCompletion(req);
    expect(res.status).toBe(404);
  });

  test("should return 401 when auth fails", async () => {
    checkAuth.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 }),
    );

    const req = new Request("http://localhost:4000/v1/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer bad" },
      body: JSON.stringify({ model: "test-model", prompt: "Hi" }),
    });

    const res = await handleCompletion(req);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Backend response resilience tests
// ---------------------------------------------------------------------------

const makeRequest = () => new Request("http://localhost:4000/v1/completions", {
  method: "POST",
  headers: { "Authorization": "Bearer test" },
  body: JSON.stringify({ model: "test-model", prompt: "Hi" }),
});

describe("handleCompletion, backend response resilience", () => {
  test("should forward extra fields from backend response", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      id: "cmpl-test", object: "text_completion", created: 123, model: "test-model",
      choices: [{ index: 0, text: "Hello", logprobs: null, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      x_custom: true, extra_info: { foo: "bar" },
    });

    const res = await handleCompletion(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].text).toBe("Hello");
    expect(body.x_custom).toBe(true);
    expect(body.extra_info.foo).toBe("bar");
    expect(mockLogChatSync).toHaveBeenCalled();
  });

  test("should forward response when usage is missing", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      id: "cmpl-test", object: "text_completion", created: 123, model: "test-model",
      choices: [{ index: 0, text: "Hello", logprobs: null, finish_reason: "stop" }],
    });

    const res = await handleCompletion(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].text).toBe("Hello");
  });

  test("should forward response when usage is malformed", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      id: "cmpl-test", object: "text_completion", created: 123, model: "test-model",
      choices: [{ index: 0, text: "Hello", logprobs: null, finish_reason: "stop" }],
      usage: { prompt_tokens: "five", completion_tokens: "ten", total_tokens: "fifteen" },
    });

    const res = await handleCompletion(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].text).toBe("Hello");
  });

  test("should forward response when created is a string instead of number", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      id: "cmpl-test", object: "text_completion", created: "1234567890", model: "test-model",
      choices: [{ index: 0, text: "Hello", logprobs: null, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });

    const res = await handleCompletion(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].text).toBe("Hello");
    expect(body.created).toBe("1234567890");
    expect(mockLogChatSync).toHaveBeenCalled();
  });

  test("should forward response but skip logging when choices are malformed", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      id: "cmpl-test", object: "text_completion", created: 123, model: "test-model",
      choices: "not an array",
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });

    const res = await handleCompletion(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices).toBe("not an array");
    expect(mockLogChatSync).not.toHaveBeenCalled();
  });

  test("should return 502 when backend returns non-JSON body", async () => {
    nextUpstreamResponse = new Response("not json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const res = await handleCompletion(makeRequest());
    expect(res.status).toBe(502);
  });
});
