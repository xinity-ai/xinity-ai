import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { makeChatSseResponse, makeChatJsonResponse, makeChatSseResponseWithInterleavedReasoning, makeChatJsonResponseWithToolCalls, makeChatSseResponseWithToolCalls, makeChatJsonResponseWithReasoning, makeChatSseResponseWithReasoning, MOCK_REASONING_TOKENS, mockBackendFetch, setupResponseTestMocks, waitForResponseStatus, requestWithParams } from "./test-helpers";

const mocks = setupResponseTestMocks();
const { checkAuth, getModelInfo, responseStore, saveResponse, logChatSync } = mocks;

mockBackendFetch();

const { handleCreateResponseRequest, handleGetOrDeleteResponseRequest } = await import("./handle-responses");

let server: any;
let lastUpstreamBody: Record<string, unknown> | undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/chat/completions") {
        const body = (await req.json()) as {
          stream?: boolean;
          reasoning_effort?: string;
          response_format?: { type?: string };
          tools?: Array<{ type: string; function?: { name: string } }>;
        };
        lastUpstreamBody = body as Record<string, unknown>;

        if (body.reasoning_effort === "interleave") {
          return makeChatSseResponseWithInterleavedReasoning("test-model");
        }
        if (body.reasoning_effort) {
          if (body.stream) return makeChatSseResponseWithReasoning("test-model", ["Hello"], ["Let me ", "think."]);
          return makeChatJsonResponseWithReasoning("test-model", "Hello", "Let me think.");
        }

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
  mocks.setMockPort(server.port);
});

afterEach(() => {
  mocks.clearAll();
  lastUpstreamBody = undefined;
});

afterAll(() => {
  server.stop();
});

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
    expect(getModelInfo).toHaveBeenCalledWith("org-1", "test-model", expect.any(Array));
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

    const stored = await waitForResponseStatus(responseStore, body.id, "completed");
    expect(stored?.status).toBe("completed");
    expect(stored?.output?.[0]?.content?.[0]?.text).toBe("Hello");
  });

  test("should get a stored response", async () => {
    responseStore.set("resp_test", {
      id: "resp_test",
      object: "response",
      status: "completed",
    });

    const res = await handleGetOrDeleteResponseRequest(requestWithParams(
      new Request("http://localhost:4000/v1/responses/resp_test", {
        method: "GET",
        headers: { "Authorization": "Bearer test" },
      }),
      { responseId: "resp_test" },
    ));
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

    const res = await handleGetOrDeleteResponseRequest(requestWithParams(
      new Request("http://localhost:4000/v1/responses/resp_delete", {
        method: "DELETE",
        headers: { "Authorization": "Bearer test" },
      }),
      { responseId: "resp_delete" },
    ));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.deleted).toBe(true);
    expect(responseStore.has("resp_delete")).toBe(false);
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
  });

  test("should reject background requests that opt out of storage", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        background: true,
        store: false,
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("'background' requires 'store' to be true");
  });

  describe("call logging", () => {
    const cases: Array<[store: boolean | undefined, collectData: boolean, logged: boolean]> = [
      [undefined, true, true],
      [undefined, false, false],
      [false, true, false],
      [true, false, true],
    ];

    test.each(cases)("store %p with collectData %p logs %p", async (store, collectData, logged) => {
      checkAuth.mockImplementationOnce(async () => ({
        orgId: "org-1",
        keyId: "key-1",
        applicationId: "app-1",
        collectData,
      }));

      const req = new Request("http://localhost:4000/v1/responses", {
        method: "POST",
        headers: { "Authorization": "Bearer test" },
        body: JSON.stringify({ model: "test-model", input: "Hi", store }),
      });

      const res = await handleCreateResponseRequest(req);
      expect(res.status).toBe(200);
      expect(logChatSync).toHaveBeenCalledTimes(logged ? 1 : 0);
    });
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

  test("should reject function tools when catalog explicitly says model does not support them", async () => {
    getModelInfo.mockImplementationOnce(async () => ({
      nodeId: "node-1",
      host: `localhost:${server.port}`,
      specifier: "test-model",
      model: "test-model",
      driver: "vllm",
      authToken: null,
      tls: false,
      tags: [],
      maxContextLength: 131072,
      release: () => {},
    }));

    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        tools: [{
          type: "function",
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        }],
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("tool use");
  });

  test("should allow function tools when catalog entry is missing (legacy fallback, tags undefined)", async () => {
    getModelInfo.mockImplementationOnce(async () => ({
      nodeId: "node-1",
      host: `localhost:${server.port}`,
      specifier: "test-model",
      model: "test-model",
      driver: "vllm",
      authToken: null,
      tls: false,
      tags: undefined,
      maxContextLength: 131072,
      release: () => {},
    }));

    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "What is the weather in Berlin?",
        tools: [{
          type: "function",
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        }],
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);
  });

  test("should reject structured output when catalog explicitly says model does not support tools", async () => {
    getModelInfo.mockImplementationOnce(async () => ({
      nodeId: "node-1",
      host: `localhost:${server.port}`,
      specifier: "test-model",
      model: "test-model",
      driver: "vllm",
      authToken: null,
      tls: false,
      tags: [],
      maxContextLength: 131072,
      release: () => {},
    }));

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
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("structured output");
  });

  test("should allow structured output when catalog entry is missing (legacy fallback, tags undefined)", async () => {
    getModelInfo.mockImplementationOnce(async () => ({
      nodeId: "node-1",
      host: `localhost:${server.port}`,
      specifier: "test-model",
      model: "test-model",
      driver: "vllm",
      authToken: null,
      tls: false,
      tags: undefined,
      maxContextLength: 131072,
      release: () => {},
    }));

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

  test("should forward reasoning.effort upstream as reasoning_effort", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        reasoning: { effort: "high" },
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);
    expect(lastUpstreamBody?.reasoning_effort).toBe("high");
  });

  test("should forward an effort value outside OpenAI's enum verbatim", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        reasoning: { effort: "minimal" },
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);
    expect(lastUpstreamBody?.reasoning_effort).toBe("minimal");
  });

  test("should omit reasoning_effort upstream when the client sends no effort", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "test-model", input: "Hi" }),
    });

    await handleCreateResponseRequest(req);
    expect(lastUpstreamBody).toBeDefined();
    expect(lastUpstreamBody).not.toHaveProperty("reasoning_effort");
  });

  test("should omit reasoning_effort upstream when the client sends no reasoning block at all", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "test-model", input: "Hi", reasoning: {} }),
    });

    await handleCreateResponseRequest(req);
    expect(lastUpstreamBody).toBeDefined();
    expect(lastUpstreamBody).not.toHaveProperty("reasoning_effort");
  });

  test("should not forward an explicit null effort to the backend", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        reasoning: { effort: null },
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);
    expect(lastUpstreamBody).toBeDefined();
    expect(lastUpstreamBody).not.toHaveProperty("reasoning_effort");
  });

  test("should return a reasoning output item ahead of the message and real reasoning_tokens", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        reasoning: { effort: "high" },
      }),
    });

    const res = await handleCreateResponseRequest(req);
    const body = (await res.json()) as any;

    expect(body.output?.[0]?.type).toBe("reasoning");
    expect(body.output?.[0]?.summary?.[0]).toEqual({ type: "summary_text", text: "Let me think." });
    expect(body.output?.[1]?.type).toBe("message");
    expect(body.output?.[1]?.content?.[0]?.text).toBe("Hello");
    expect(body.usage?.output_tokens_details?.reasoning_tokens).toBe(MOCK_REASONING_TOKENS);
    expect(body.reasoning).toEqual({ effort: "high", summary: null });
  });

  test("should emit the reasoning event sequence when streaming", async () => {
    const req = new Request("http://localhost:4000/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({
        model: "test-model",
        input: "Hi",
        stream: true,
        reasoning: { effort: "high" },
      }),
    });

    const res = await handleCreateResponseRequest(req);
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).toContain("response.reasoning_summary_part.added");
    expect(text).toContain("response.reasoning_summary_text.delta");
    expect(text).toContain("response.reasoning_summary_text.done");
    expect(text).toContain("response.reasoning_summary_part.done");

    const events = text.split("\n\n").filter(Boolean).map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "))!;
      return JSON.parse(dataLine.slice(6));
    });

    // Reasoning precedes the message, so it takes output_index 0 and pushes the message to 1
    const reasoningDeltas = events.filter((e) => e.type === "response.reasoning_summary_text.delta");
    expect(reasoningDeltas.map((e) => e.delta).join("")).toBe("Let me think.");
    expect(reasoningDeltas.every((e) => e.output_index === 0)).toBe(true);

    const textDeltas = events.filter((e) => e.type === "response.output_text.delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas.every((e) => e.output_index === 1)).toBe(true);

    const sequenceNumbers = events.map((e) => e.sequence_number);
    expect(sequenceNumbers).toEqual([...sequenceNumbers].sort((a, b) => a - b));

    const completed = events.find((e) => e.type === "response.completed");
    expect(completed.response.output[0].type).toBe("reasoning");
    expect(completed.response.output[0].summary[0].text).toBe("Let me think.");
    expect(completed.response.usage.output_tokens_details.reasoning_tokens).toBe(MOCK_REASONING_TOKENS);
  });

  test("should complete every reasoning item when reasoning resumes after content", async () => {
    const res = await handleCreateResponseRequest(new Request("http://x/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", input: "Hi", stream: true, reasoning: { effort: "interleave" } }),
    }));
    const events = (await res.text()).split("\n\n").filter(Boolean).flatMap((block) => {
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      try { return [JSON.parse(line!.slice(6))]; } catch { return []; }
    });

    const added = events.filter((e) => e.type === "response.output_item.added");
    const done = events.filter((e) => e.type === "response.output_item.done");
    expect(added.map((e) => e.item.type)).toEqual(["reasoning", "message", "reasoning"]);
    // Completion order follows finish time, not add order: the message item is finalized last.
    expect(done.map((e) => e.output_index).sort()).toEqual(added.map((e) => e.output_index).sort());

    const reasoningIds = added.filter((e) => e.item.type === "reasoning").map((e) => e.item.id);
    expect(new Set(reasoningIds).size).toBe(2);

    const completed = events.find((e) => e.type === "response.completed");
    expect(completed.response.output.map((o: { type: string }) => o.type)).toEqual(["reasoning", "reasoning", "message"]);
    expect(completed.response.output[0].summary[0].text).toBe("first block");
    expect(completed.response.output[1].summary[0].text).toBe("second block");
  });
});
