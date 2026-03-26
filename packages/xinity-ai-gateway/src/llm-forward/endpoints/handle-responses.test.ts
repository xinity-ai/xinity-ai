import { describe, test, expect, mock, beforeAll, afterAll, jest, afterEach } from "bun:test";
import { makeChatSseResponse, makeChatJsonResponse, makeChatJsonResponseWithToolCalls, makeChatSseResponseWithToolCalls } from "./test-helpers";

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

const checkAuth = jest.fn(async () => ({
  orgId: "org-1",
  keyId: "key-1",
  applicationId: "app-1",
}));

mock.module("../auth", () => ({
  checkAuth,
}));

let mockPort = 0;
const getModelInfo = jest.fn(async () => ({
  host: `localhost:${mockPort}`,
  model: "test-model",
  driver: "vllm",
  tags: ["tools"],
  release: () => {},
}));

mock.module("../model-data", () => ({
  getModelInfo,
}));

const responseStore = new Map<string, any>();
const saveResponse = jest.fn(async (_orgId: string, id: string, payload: any) => {
  responseStore.set(id, payload);
});
const getResponse = jest.fn(async (_orgId: string, id: string) => responseStore.get(id) ?? null);
const deleteResponse = jest.fn(async (_orgId: string, id: string) => {
  responseStore.delete(id);
});

mock.module("../response-store", () => ({
  saveResponse,
  getResponse,
  deleteResponse,
}));

const logChatSync = jest.fn();
const logChatStream = jest.fn();

mock.module("../../callLogger", () => ({
  logChatSync,
  logChatStream,
}));

mock.module("../../usageRecorder", () => ({
  recordUsageEvent: mock(() => {}),
}));

const { handleCreateResponseRequest, handleGetOrDeleteResponseRequest } = await import("./handle-responses");

let server: any;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/chat/completions") {
        const body = (await req.json()) as {
          stream?: boolean;
          response_format?: { type?: string };
          tools?: Array<{ type: string; function?: { name: string } }>;
        };

        // If the request includes user-defined function tools (not built-in web_search/web_fetch
        // which the AI SDK also sends as type:"function"), return a tool call response
        const userFunctionTool = body.tools?.find((t) =>
          t.type === "function" && t.function?.name !== "web_search" && t.function?.name !== "web_fetch"
        );
        if (userFunctionTool) {
          const firstFn = userFunctionTool;
          const toolCall = { id: "call_mock_1", name: firstFn.function!.name, arguments: '{"city":"Berlin"}' };
          if (body.stream) return makeChatSseResponseWithToolCalls("test-model", [toolCall]);
          return makeChatJsonResponseWithToolCalls("test-model", [toolCall]);
        }

        const wantsJson = body.response_format?.type === "json_schema" || body.response_format?.type === "json_object";
        const content = wantsJson ? JSON.stringify({ greeting: "Hello" }) : "Hello";
        if (body.stream) return makeChatSseResponse("test-model", [content]);
        return makeChatJsonResponse("test-model", content);
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  mockPort = server.port;
});

afterEach(() => {
  checkAuth.mockClear();
  getModelInfo.mockClear();
  saveResponse.mockClear();
  getResponse.mockClear();
  deleteResponse.mockClear();
  logChatSync.mockClear();
  logChatStream.mockClear();
  responseStore.clear();
});

afterAll(() => {
  server.stop();
});

const waitForResponseStatus = async (responseId: string, status: string) => {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const stored = responseStore.get(responseId);
    if (stored?.status === status) {
      return stored;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return null;
};

describe("handleResponses", () => {
  test("should create a non-streaming response", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toStartWith("application/json");

    const body = (await res.json()) as any;
    expect(body.id).toContain("resp_");
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.output?.[0]?.content?.[0]?.text).toBe("Hello");
    expect(checkAuth).toHaveBeenCalledWith("Bearer test");
    expect(getModelInfo).toHaveBeenCalledWith("org-1", "test-model", "key-1");
    expect(responseStore.get(body.id)?.status).toBe("completed");
  });

  test("should create a streaming response", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        stream: true,
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await res.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.completed");
    expect(text).toContain("response.completed");

    expect(saveResponse.mock.calls.length).toBeGreaterThan(0);
    const responseId = saveResponse.mock.calls[0]?.[1] as string;
    expect(responseId).toContain("resp_");
    expect(responseStore.get(responseId)?.status).toBe("completed");
  });

  test("should create a background response", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        background: true,
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(202);

    const body = (await res.json()) as any;
    expect(body.status).toBe("in_progress");
    expect(body.id).toContain("resp_");

    const stored = await waitForResponseStatus(body.id, "completed");
    expect(stored?.status).toBe("completed");
    expect(stored?.output?.[0]?.content?.[0]?.text).toBe("Hello");
  });

  test("should get a stored response", async () => {
    responseStore.set("resp_test", {
      id: "resp_test",
      object: "response",
      status: "completed",
    });

    const req = new Request("http://localhost:4000/v1/responses/resp_test", {
      method: "GET",
      headers: { "Authorization": "Bearer test" },
    });

    const res = await handleGetOrDeleteResponseRequest(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe("resp_test");
    expect(checkAuth).toHaveBeenCalledWith("Bearer test");
  });

  test("should delete a stored response", async () => {
    responseStore.set("resp_delete", {
      id: "resp_delete",
      object: "response",
      status: "completed",
    });

    const req = new Request("http://localhost:4000/v1/responses/resp_delete", {
      method: "DELETE",
      headers: { "Authorization": "Bearer test" },
    });

    const res = await handleGetOrDeleteResponseRequest(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.deleted).toBe(true);
    expect(responseStore.has("resp_delete")).toBe(false);
  });

  test("should accept include parameter", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        include: ["web_search_call.results"],
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);
    
    const body = (await res.json()) as any;
    expect(body.id).toContain("resp_");
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
  });

  test("should accept tools parameter", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        tools: [{ type: "web_search" }],
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);
    
    const body = (await res.json()) as any;
    expect(body.id).toContain("resp_");
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
  });

  test("should accept tools parameter as array of strings", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        tools: ["web_search"],
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);
    
    const body = (await res.json()) as any;
    expect(body.id).toContain("resp_");
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
  });

  test("should handle both tools and include parameters together", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        tools: [{ type: "web_search" }],
        include: ["web_search_call.results", "web_search_call.action.sources"],
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);
    
    const body = (await res.json()) as any;
    expect(body.id).toContain("resp_");
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(Array.isArray(body.output)).toBe(true);
  });

  test("should accept text config for structured output", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        text: {
          format: {
            type: "json_schema",
            json_schema: {
              name: "TestSchema",
              schema: { type: "object", properties: { greeting: { type: "string" } } },
            },
          },
        },
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.id).toContain("resp_");
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.output?.[0]?.content?.[0]?.text).toBe(JSON.stringify({ greeting: "Hello" }));
  });

  test("should cache response when store is false", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        store: false,
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(responseStore.has(body.id)).toBe(true);
    expect(logChatSync).not.toHaveBeenCalled();
  });

  test("should include metadata in response", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        metadata: { trace_id: "trace-123" },
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.metadata).toEqual({ trace_id: "trace-123" });
  });

  test("should return 404 for unknown previous_response_id", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        previous_response_id: "resp_missing",
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(404);
  });

  test("should accept tool_choice none", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        tools: [{ type: "web_search" }],
        tool_choice: "none",
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);
  });

  test("should accept web_search_preview tool type", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        tools: [{ type: "web_search_preview" }],
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);
  });

  test("should accept web_search_preview_2025_03_11 tool type", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        tools: [{ type: "web_search_preview_2025_03_11" }],
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);
  });

  test("should return function_call output items when model calls a function tool", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "What is the weather in Berlin?",
        tools: [{
          type: "function",
          name: "get_weather",
          description: "Get weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        }],
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.status).toBe("completed");

    const functionCallItem = body.output?.find((item: any) => item.type === "function_call");
    expect(functionCallItem).toBeDefined();
    expect(functionCallItem.name).toBe("get_weather");
    expect(functionCallItem.status).toBe("completed");
    expect(functionCallItem.call_id).toBeDefined();
    expect(functionCallItem.arguments).toBe('{"city":"Berlin"}');
  });

  test("should accept function_call_output in input for multi-turn tool use", async () => {
    // First, create a response that ends with a function_call
    const req1 = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "What is the weather?",
        tools: [{
          type: "function",
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        }],
      }),
    });

    const res1 = await handleCreateResponseRequest(req1);
    const body1 = (await res1.json()) as any;
    const responseId = body1.id;

    // Now send a follow-up with function_call_output
    const functionCallItem = body1.output?.find((item: any) => item.type === "function_call");
    const req2 = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: [
          { type: "function_call_output", call_id: functionCallItem.call_id, output: '{"temp": 20}' },
        ],
        previous_response_id: responseId,
      }),
    });

    const res2 = await handleCreateResponseRequest(req2);
    expect(res2.status).toBe(200);

    const body2 = (await res2.json()) as any;
    expect(body2.status).toBe("completed");
    expect(body2.previous_response_id).toBe(responseId);
  });
});
