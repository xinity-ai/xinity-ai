import { afterAll, afterEach, beforeAll, describe, expect, mock, test, jest } from "bun:test";
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
  model: "test-embedding",
  driver: "vllm",
  authToken: null,
  tls: false,
  type: "embedding",
  tags: [],
  requestParams: {},
  release: () => {},
}));

mock.module("../model-data", () => ({
  getModelInfo,
}));

mock.module("../backend-fetch", () => ({
  backendUrl: (host: string, _model: string, path: string, _tls: boolean) => `http://${host}${path}`,
  backendFetch: (url: string | URL | Request, init?: RequestInit) => fetch(url, init),
  hasCustomCa: false,
}));

mock.module("../../usageRecorder", () => ({
  recordUsageEvent: mock(() => {}),
}));

const { handleEmbeddingGeneration } = await import("./handle-embeddings");

let server: ReturnType<typeof Bun.serve>;
let nextUpstreamResponse: Response | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/embeddings") {
        if (nextUpstreamResponse) {
          const r = nextUpstreamResponse;
          nextUpstreamResponse = null;
          return r;
        }
        const body = await req.json() as { model: string; input: string | string[]; encoding_format?: string };
        const isArray = Array.isArray(body.input);
        const count = isArray ? body.input.length : 1;

        const data = Array.from({ length: count }, (_, i) => ({
          object: "embedding",
          embedding: isArray ? [3, 4] : [1, 2],
          index: i,
        }));

        return Response.json({
          object: "list",
          data,
          model: body.model,
          usage: { prompt_tokens: isArray ? 8 : 4, total_tokens: isArray ? 8 : 4 },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  mockPort = server.port!;
});

afterEach(() => {
  checkAuth.mockClear();
  getModelInfo.mockClear();
  nextUpstreamResponse = null;
});

afterAll(() => {
  server.stop();
});

describe("handleEmbeddingGeneration", () => {
  test("returns float embedding for string input", async () => {
    const req = new Request("http://localhost:4000/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-embedding",
        input: "hello",
      }),
    });

    const res = await handleEmbeddingGeneration(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data[0].embedding).toEqual([1, 2]);
    expect(body.usage.total_tokens).toBe(4);
    // Model name should be swapped to the user-specified originalModel
    expect(body.model).toBe("test-embedding");
  });

  test("returns embedding for array input", async () => {
    const req = new Request("http://localhost:4000/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-embedding",
        input: ["hello", "world"],
      }),
    });

    const res = await handleEmbeddingGeneration(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toHaveLength(2);
    expect(body.data[0].embedding).toEqual([3, 4]);
    expect(body.data[1].embedding).toEqual([3, 4]);
  });

  test("returns 400 for invalid encoding format", async () => {
    const req = new Request("http://localhost:4000/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-embedding",
        input: "hello",
        encoding_format: "invalid",
      }),
    });

    const res = await handleEmbeddingGeneration(req);
    expect(res.status).toBe(400);
  });

  test("returns 400 for unsupported input", async () => {
    const req = new Request("http://localhost:4000/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-embedding",
        input: { value: "hello" },
      }),
    });

    const res = await handleEmbeddingGeneration(req);
    expect(res.status).toBe(400);
  });

  test("forwards 4xx from upstream as-is", async () => {
    nextUpstreamResponse = new Response(
      JSON.stringify({ error: { message: "Input too long", type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );

    const req = new Request("http://localhost:4000/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "test-embedding", input: "hello" }),
    });

    const res = await handleEmbeddingGeneration(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("Input too long");
  });

  test("maps 5xx from upstream to 502", async () => {
    nextUpstreamResponse = new Response("Internal Server Error", { status: 500 });

    const req = new Request("http://localhost:4000/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "test-embedding", input: "hello" }),
    });

    const res = await handleEmbeddingGeneration(req);
    expect(res.status).toBe(502);
  });

  test("returns 404 when model is not found", async () => {
    getModelInfo.mockImplementationOnce(async () => undefined);

    const req = new Request("http://localhost:4000/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "nonexistent", input: "hello" }),
    });

    const res = await handleEmbeddingGeneration(req);
    expect(res.status).toBe(404);
  });

  test("returns 400 when model type is wrong", async () => {
    getModelInfo.mockImplementationOnce(async () => ({
      host: `localhost:${mockPort}`,
      model: "test-chat-model",
      driver: "vllm",
      type: "chat",
      tags: [],
      requestParams: {},
      release: () => {},
    }));

    const req = new Request("http://localhost:4000/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "test-chat-model", input: "hello" }),
    });

    const res = await handleEmbeddingGeneration(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("not supported");
  });
});

// ---------------------------------------------------------------------------
// Backend response resilience tests
// ---------------------------------------------------------------------------

const makeRequest = () => new Request("http://localhost:4000/v1/embeddings", {
  method: "POST",
  headers: { "Authorization": "Bearer test" },
  body: JSON.stringify({ model: "test-embedding", input: "hello" }),
});

describe("handleEmbeddingGeneration, backend response resilience", () => {
  test("should forward extra fields from backend response", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      object: "list",
      data: [{ object: "embedding", embedding: [1, 2], index: 0 }],
      model: "test-embedding",
      usage: { prompt_tokens: 4, total_tokens: 4 },
      x_custom: true,
    });

    const res = await handleEmbeddingGeneration(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data[0].embedding).toEqual([1, 2]);
    expect(body.x_custom).toBe(true);
  });

  test("should forward response when usage is missing", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      object: "list",
      data: [{ object: "embedding", embedding: [1, 2], index: 0 }],
      model: "test-embedding",
    });

    const res = await handleEmbeddingGeneration(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data[0].embedding).toEqual([1, 2]);
  });

  test("should forward response when usage is malformed", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      object: "list",
      data: [{ object: "embedding", embedding: [1, 2], index: 0 }],
      model: "test-embedding",
      usage: { prompt_tokens: "four", total_tokens: "four" },
    });

    const res = await handleEmbeddingGeneration(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data[0].embedding).toEqual([1, 2]);
  });

  test("should forward response when data has unexpected shape", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      object: "list",
      data: "not an array",
      model: "test-embedding",
      usage: { prompt_tokens: 4, total_tokens: 4 },
    });

    const res = await handleEmbeddingGeneration(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toBe("not an array");
  });

  test("should return 502 when backend returns non-JSON body", async () => {
    nextUpstreamResponse = new Response("not json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const res = await handleEmbeddingGeneration(makeRequest());
    expect(res.status).toBe(502);
  });
});
