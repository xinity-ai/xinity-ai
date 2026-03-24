import { describe, test, expect, mock, beforeAll, afterAll, jest, afterEach } from "bun:test";
import {
  makeChatSseResponse,
  makeChatJsonResponse,
  makeChatJsonResponseWithToolCalls,
  makeChatSseResponseWithToolCalls,
  makeRawJsonResponse,
} from "./test-helpers";

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
  tags: ["tools"],
  requestParams: {},
  release: () => {},
}))
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

const { handleChatCompletion } = await import("./handle-chatCompletion");

const MOCK_TOOL_CALLS = [{ id: "call_test123", name: "get_weather", arguments: '{"location":"Boston"}' }];

const SAMPLE_TOOLS = [{
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get the weather for a location",
    parameters: {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
    },
  },
}];

// Captures the last request body sent to the mock upstream
let lastUpstreamBody: Record<string, unknown> | null = null;

// Mock upstream server that returns tool call responses when tools are in the request
let server: any;
let nextUpstreamResponse: Response | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/chat/completions") {
        if (nextUpstreamResponse) {
          const r = nextUpstreamResponse;
          nextUpstreamResponse = null;
          return r;
        }
        const body = (await req.json()) as {
          stream?: boolean;
          response_format?: { type?: string };
          tools?: unknown[];
          tool_choice?: unknown;
          messages?: unknown[];
        };
        lastUpstreamBody = body;

        // If tools are present and tool_choice is not "none", return tool calls
        if (body.tools && Array.isArray(body.tools) && body.tools.length > 0 && body.tool_choice !== "none") {
          if (body.stream) return makeChatSseResponseWithToolCalls("test-model", MOCK_TOOL_CALLS);
          return makeChatJsonResponseWithToolCalls("test-model", MOCK_TOOL_CALLS);
        }

        const wantsJson = body.response_format?.type === "json_schema" || body.response_format?.type === "json_object";
        const content = wantsJson ? JSON.stringify({ greeting: "Hello" }) : "Hello";
        if (body.stream) return makeChatSseResponse("test-model", [content]);
        return makeChatJsonResponse("test-model", content);
      }
      return new Response("Not Found", { status: 404 });
    }
  });
  mockPort = server.port;
});
afterEach(() => {
  checkAuth.mockClear();
  getModelInfo.mockClear();
  mockLogChatStream.mockClear();
  mockLogChatSync.mockClear();
  lastUpstreamBody = null;
  nextUpstreamResponse = null;
})

afterAll(() => {
  server.stop();
});

describe("handleChatCompletion", () => {
  test("should handle streaming request with role chunk, content, finish with usage", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
        stream: true
      })
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await res.text();
    // Role announcement chunk
    expect(text).toContain('"role":"assistant"');
    // Content delta
    expect(text).toContain('"content":"Hello"');
    // Finish chunk with usage
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"usage"');
    // Terminator
    expect(text).toContain('data: [DONE]');
    expect(checkAuth).toHaveBeenCalledWith("Bearer test");
    expect(getModelInfo).toHaveBeenCalledWith("org-1", "test-model", "key-1");
  });

  test("should handle non-streaming request", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test2" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
        stream: false
      })
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = await res.json() as any;
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("test-model");
    expect(body.choices?.[0]?.message?.content).toBe("Hello");
    expect(body.choices?.[0]?.finish_reason).toBe("stop");
    expect(checkAuth).toHaveBeenCalledWith("Bearer test2");
    expect(getModelInfo).toHaveBeenCalledWith("org-1", "test-model", "key-1");
  });

  test("should skip call logging when store is false", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test3" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
        store: false
      })
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);
    expect(mockLogChatSync).not.toHaveBeenCalled();
  });

  test("should support response_format json_object", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
        response_format: { type: "json_object" },
      })
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.object).toBe("chat.completion");
    const content = body.choices?.[0]?.message?.content;
    expect(content).toBeDefined();
    // Content should be valid JSON
    expect(() => JSON.parse(content)).not.toThrow();
  });

  test("should support response_format json_schema", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "TestSchema",
            schema: { type: "object", properties: { greeting: { type: "string" } } },
          },
        },
      })
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.object).toBe("chat.completion");
    const content = body.choices?.[0]?.message?.content;
    expect(content).toBeDefined();
    const parsed = JSON.parse(content);
    expect(parsed).toHaveProperty("greeting");
  });

  test("should support response_format json_schema with streaming", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "TestSchema",
            schema: { type: "object", properties: { greeting: { type: "string" } } },
          },
        },
      })
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await res.text();
    expect(text).toContain("greeting");
    expect(text).toContain("data: [DONE]");
  });

  test("should accept structured_outputs for vLLM driver", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
        structured_outputs: { regex: "\\d{3}-\\d{4}" },
      })
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);
  });

  test("should reject structured_outputs for non-vLLM driver", async () => {
    getModelInfo.mockImplementationOnce(async () => ({
      host: `localhost:${mockPort}`,
      model: "test-model",
      driver: "ollama",
      tags: [],
      requestParams: {},
      release: () => {},
    }));

    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
        structured_outputs: { regex: "\\d+" },
      })
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error?.message).toContain("structured_outputs");
  });
});

// ---------------------------------------------------------------------------
// Tool calling tests
// ---------------------------------------------------------------------------

describe("handleChatCompletion, tool calling", () => {
  test("should return tool calls in non-streaming response", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "What is the weather in Boston?" }],
        tools: SAMPLE_TOOLS,
      }),
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.content).toBeNull();

    const toolCalls = body.choices[0].message.tool_calls;
    expect(toolCalls).toBeArray();
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].id).toBe("call_test123");
    expect(toolCalls[0].type).toBe("function");
    expect(toolCalls[0].function.name).toBe("get_weather");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ location: "Boston" });
  });

  test("should return tool calls in streaming response", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "What is the weather in Boston?" }],
        tools: SAMPLE_TOOLS,
        stream: true,
      }),
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await res.text();
    expect(text).toContain("data: [DONE]");
    // Should contain tool_calls in the SSE chunks
    expect(text).toContain("tool_calls");
    expect(text).toContain("get_weather");
    // Should contain the finish reason for tool calls
    expect(text).toContain('"finish_reason":"tool_calls"');
  });

  test("should forward tool_choice 'required' and tools to upstream", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hello" }],
        tools: SAMPLE_TOOLS,
        tool_choice: "required",
      }),
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls).toBeArray();
    expect(body.choices[0].message.tool_calls.length).toBeGreaterThan(0);

    // Verify tools and tool_choice are forwarded to the upstream
    expect(lastUpstreamBody?.tools).toBeDefined();
    expect((lastUpstreamBody?.tools as any[]).length).toBe(1);
    expect((lastUpstreamBody?.tools as any[])[0].function.name).toBe("get_weather");
    expect(lastUpstreamBody?.tool_choice).toBe("required");
  });

  test("should not pass tools when tool_choice is 'none'", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hello" }],
        tools: SAMPLE_TOOLS,
        tool_choice: "none",
      }),
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    // With tool_choice "none", the model should return text, not tool calls
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.choices[0].message.content).toBe("Hello");
    expect(body.choices[0].message.tool_calls).toBeUndefined();
  });

  test("should forward specific function tool_choice to upstream", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hello" }],
        tools: SAMPLE_TOOLS,
        tool_choice: { type: "function", function: { name: "get_weather" } },
      }),
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("get_weather");

    // Verify the specific function tool_choice is sent to upstream
    expect(lastUpstreamBody?.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
  });

  test("should reject tools when model does not support them", async () => {
    getModelInfo.mockImplementationOnce(async () => ({
      host: `localhost:${mockPort}`,
      model: "test-model",
      driver: "vllm",
      tags: [],
      requestParams: {},
      release: () => {},
    }));

    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hello" }],
        tools: SAMPLE_TOOLS,
      }),
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(400);

    const body = await res.json() as any;
    expect(body.error.message).toContain("tool use");
  });

  test("should work without tools (backward compatibility)", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.choices[0].message.content).toBe("Hello");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.choices[0].message.tool_calls).toBeUndefined();
  });

  test("should forward tool result messages to upstream in OpenAI format", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [
          { role: "user", content: "What is the weather in Boston?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_prev123",
              type: "function",
              function: { name: "get_weather", arguments: '{"location":"Boston"}' },
            }],
          },
          {
            role: "tool",
            tool_call_id: "call_prev123",
            content: '{"temperature": 72, "condition": "sunny"}',
          },
          { role: "user", content: "And in New York?" },
        ],
        tools: SAMPLE_TOOLS,
      }),
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.choices[0].message.tool_calls).toBeArray();

    // Verify the upstream received all messages including the tool result
    const upstreamMessages = lastUpstreamBody?.messages as any[];
    expect(upstreamMessages).toBeDefined();

    // Find the tool result message in the upstream request
    const toolMsg = upstreamMessages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe("call_prev123");
    expect(toolMsg.content).toBe('{"temperature": 72, "condition": "sunny"}');

    // Find the assistant message with tool_calls
    const assistantMsg = upstreamMessages.find((m: any) => m.role === "assistant" && m.tool_calls);
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.tool_calls[0].id).toBe("call_prev123");
    expect(assistantMsg.tool_calls[0].function.name).toBe("get_weather");
  });

  test("should handle multiple tools in a single request", async () => {
    const multiTools = [
      ...SAMPLE_TOOLS,
      {
        type: "function" as const,
        function: {
          name: "get_time",
          description: "Get the current time in a timezone",
          parameters: {
            type: "object",
            properties: { timezone: { type: "string" } },
          },
        },
      },
    ];

    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "What is the weather?" }],
        tools: multiTools,
      }),
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.choices[0].message.tool_calls).toBeArray();
  });
});

// ---------------------------------------------------------------------------
// Upstream & auth error handling
// ---------------------------------------------------------------------------

describe("handleChatCompletion, error handling", () => {
  test("should forward 4xx from upstream as-is", async () => {
    nextUpstreamResponse = new Response(
      JSON.stringify({ error: { message: "Context length exceeded", type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );

    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("Context length exceeded");
  });

  test("should map 5xx from upstream to 502", async () => {
    nextUpstreamResponse = new Response("Internal Server Error", { status: 500 });

    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(502);
  });

  test("should return 404 when model is not found", async () => {
    getModelInfo.mockImplementationOnce(async () => undefined);

    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "nonexistent",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(404);
  });

  test("should return 401 when auth fails", async () => {
    checkAuth.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 }),
    );

    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer bad" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(401);
  });

  test("should return 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test", "Content-Type": "application/json" },
      body: "not json",
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(400);
  });

  test("should return 400 when model field is missing", async () => {
    const req = new Request("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    const res = await handleChatCompletion(req);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Backend response resilience tests
// ---------------------------------------------------------------------------

const makeRequest = () => new Request("http://localhost:4000/v1/chat/completions", {
  method: "POST",
  headers: { "Authorization": "Bearer test" },
  body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
});

describe("handleChatCompletion, backend response resilience", () => {
  test("should forward extra fields from backend response", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      id: "test-id", object: "chat.completion", created: 123, model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      x_custom: true, extra_info: { foo: "bar" },
    });

    const res = await handleChatCompletion(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].message.content).toBe("Hello");
    expect(body.x_custom).toBe(true);
    expect(body.extra_info.foo).toBe("bar");
    expect(mockLogChatSync).toHaveBeenCalled();
  });

  test("should forward response when usage is missing", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      id: "test-id", object: "chat.completion", created: 123, model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
    });

    const res = await handleChatCompletion(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].message.content).toBe("Hello");
  });

  test("should forward response when usage is malformed", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      id: "test-id", object: "chat.completion", created: 123, model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: "five", completion_tokens: "ten", total_tokens: "fifteen" },
    });

    const res = await handleChatCompletion(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].message.content).toBe("Hello");
  });

  test("should forward response when created is a string instead of number", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      id: "test-id", object: "chat.completion", created: "1234567890", model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });

    const res = await handleChatCompletion(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].message.content).toBe("Hello");
    expect(body.created).toBe("1234567890");
    expect(mockLogChatSync).toHaveBeenCalled();
  });

  test("should forward response but skip logging when choices are malformed", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      id: "test-id", object: "chat.completion", created: 123, model: "test-model",
      choices: "not an array",
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });

    const res = await handleChatCompletion(makeRequest());
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

    const res = await handleChatCompletion(makeRequest());
    expect(res.status).toBe(502);
  });

  test("should log correctly with fully conforming response", async () => {
    nextUpstreamResponse = makeRawJsonResponse({
      id: "test-id", object: "chat.completion", created: 123, model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });

    const res = await handleChatCompletion(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].message.content).toBe("Hello");
    expect(body.model).toBe("test-model");
    expect(mockLogChatSync).toHaveBeenCalled();
  });
});
