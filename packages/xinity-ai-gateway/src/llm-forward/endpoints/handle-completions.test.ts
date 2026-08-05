import { describe, test, expect, mock, beforeAll, afterAll, jest, afterEach } from "bun:test";
import { mockBackendFetch } from "./test-helpers";

import { MOCK_GATEWAY_ENV } from "../mock-env";
mock.module("../../env", () => ({ env: { ...MOCK_GATEWAY_ENV } }));

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
  nodeId: "node-1",
  host: `localhost:${mockPort}`,
  specifier: "test-model",
  model: "test-model",
  driver: "vllm",
  authToken: null,
  tls: false,
  tags: [],
  requestParams: {},
  maxContextLength: 131072,
  release: () => {},
}));

mock.module("../model-data", () => ({
  getModelInfo,
}));

mockBackendFetch();

const mockLogChatStream = mock(() => Promise.resolve());
const mockLogChatSync = mock(() => Promise.resolve());

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
let lastUpstreamBody: Record<string, unknown> | null = null;

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
        const body = (await req.json()) as Record<string, unknown>;
        lastUpstreamBody = body;
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
  lastUpstreamBody = null;
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

  test("forwards logprobs to the backend", async () => {
    const req = new Request("http://localhost:4000/v1/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "test-model", prompt: "Hi", logprobs: 5 }),
    });

    const res = await handleCompletion(req);
    expect(res.status).toBe(200);
    expect(lastUpstreamBody?.logprobs).toBe(5);
  });

  test("passes backend logprobs through to the client", async () => {
    nextUpstreamResponse = Response.json({
      id: "test-id", object: "text_completion", created: 123, model: "test-model",
      choices: [{ index: 0, text: "Hello", finish_reason: "stop", logprobs: { tokens: ["Hello"], token_logprobs: [-0.1] } }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });
    const req = new Request("http://localhost:4000/v1/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "test-model", prompt: "Hi" }),
    });

    const res = await handleCompletion(req);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].logprobs).toEqual({ tokens: ["Hello"], token_logprobs: [-0.1] });
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

});
