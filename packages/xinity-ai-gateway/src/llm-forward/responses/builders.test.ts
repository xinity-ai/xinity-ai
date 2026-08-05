import { describe, test, expect, mock } from "bun:test";
import { CreateResponseBodySchema, type CreateResponseBody, type MessageOutputItem } from "./schemas";
import type {
  ToolCallItem,
  ToolResultData,
  ResponsePayloadParams,
} from "./builders";

import { MOCK_GATEWAY_ENV } from "../mock-env";
mock.module("../../env", () => ({
  env: { ...MOCK_GATEWAY_ENV, METRICS_AUTH: [] },
}));

const {
  createToolTracker,
  resolveActiveTools,
  parseFunctionTools,
  buildFunctionToolSet,
  buildOutputConfig,
  resolveResponseText,
  formatUsage,
  createResponseObject,
  markResponseFailed,
  extractSearchAnnotations,
  buildOutputItems,
  buildStepOutputItems,
} = await import("./builders");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const minimalBody: CreateResponseBody = { model: "test-model", input: "hello" } as CreateResponseBody;

function makeParams(overrides: Partial<ResponsePayloadParams> = {}): ResponsePayloadParams {
  return {
    responseId: "resp_001",
    createdAt: 1700000000,
    model: "test-model",
    status: "completed",
    body: minimalBody,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createToolTracker
// ---------------------------------------------------------------------------

describe("createToolTracker", () => {
  test("accumulates web_search tool calls and ignores web_fetch", () => {
    const toolCalls: ToolCallItem[] = [];
    const toolResults: ToolResultData[] = [];
    const tracker = createToolTracker(toolCalls, toolResults);

    tracker({
      toolCalls: [
        { toolCallId: "tc_1", toolName: "web_search" },
        { toolCallId: "tc_2", toolName: "web_fetch" },
        { toolCallId: "tc_3", toolName: "web_search" },
      ],
    });

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]!.type).toBe("web_search_call");
    expect(toolCalls[0]!.status).toBe("completed");
    expect(toolCalls[0]!.aiToolCallId).toBe("tc_1");
    expect(toolCalls[1]!.aiToolCallId).toBe("tc_3");
  });

  test("tracks function tool calls with name, callId, and arguments", () => {
    const toolCalls: ToolCallItem[] = [];
    const toolResults: ToolResultData[] = [];
    const tracker = createToolTracker(toolCalls, toolResults);

    tracker({
      toolCalls: [
        { toolCallId: "tc_1", toolName: "get_weather", input: { city: "Berlin" } },
      ],
    });

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.type).toBe("function_call");
    expect(toolCalls[0]!.name).toBe("get_weather");
    expect(toolCalls[0]!.callId).toBe("tc_1");
    expect(toolCalls[0]!.arguments).toBe(JSON.stringify({ city: "Berlin" }));
  });

  test("accumulates all tool results regardless of tool name", () => {
    const toolCalls: ToolCallItem[] = [];
    const toolResults: ToolResultData[] = [];
    const tracker = createToolTracker(toolCalls, toolResults);

    tracker({
      toolResults: [
        { toolCallId: "tc_1", toolName: "web_search", input: { q: "test" }, output: { results: [] } },
        { toolCallId: "tc_2", toolName: "web_fetch", input: { url: "https://x.com" }, output: "page content" },
      ],
    });

    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]!.toolName).toBe("web_search");
    expect(toolResults[1]!.toolName).toBe("web_fetch");
  });

  test("skips entries with empty toolCallId", () => {
    const toolCalls: ToolCallItem[] = [];
    const toolResults: ToolResultData[] = [];
    const tracker = createToolTracker(toolCalls, toolResults);

    tracker({
      toolCalls: [{ toolCallId: "", toolName: "web_search" }],
      toolResults: [{ toolCallId: "", toolName: "web_search", input: {}, output: {} }],
    });

    expect(toolCalls).toHaveLength(0);
    expect(toolResults).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveActiveTools
// ---------------------------------------------------------------------------

describe("resolveActiveTools", () => {
  test("returns empty when toolChoice is 'none'", () => {
    const { activeTools } = resolveActiveTools([{ type: "web_search" }], "none");
    expect(Object.keys(activeTools)).toHaveLength(0);
  });

  test("resolves a specific tool when toolChoice is a known name", () => {
    const { activeTools, hasBuiltinTools } = resolveActiveTools([], "web_search");
    expect(activeTools).toHaveProperty("web_search");
    expect(activeTools).toHaveProperty("web_fetch");
    expect(hasBuiltinTools).toBe(true);
  });

  test("parses tool definitions from tools array (object form)", () => {
    const { activeTools } = resolveActiveTools([{ type: "web_search" }], "auto");
    expect(activeTools).toHaveProperty("web_search");
    expect(activeTools).toHaveProperty("web_fetch");
  });

  test("ignores unknown tool types (not builtin, not function)", () => {
    const { activeTools } = resolveActiveTools([{ type: "unknown_tool" }], "auto");
    expect(Object.keys(activeTools)).toHaveLength(0);
  });

  test("handles toolChoice as object with type", () => {
    const { activeTools } = resolveActiveTools([], { type: "web_search" });
    expect(activeTools).toHaveProperty("web_search");
    expect(activeTools).toHaveProperty("web_fetch");
  });

  test("normalises web_search_preview to web_search via schema transform", () => {
    const parsed = CreateResponseBodySchema.parse({
      model: "m", input: "hi", tools: [{ type: "web_search_preview" }],
    });
    const { activeTools } = resolveActiveTools(parsed.tools, "auto");
    expect(activeTools).toHaveProperty("web_search");
    expect(activeTools).toHaveProperty("web_fetch");
  });

  test("normalises string-form web_search_preview via schema transform", () => {
    const parsed = CreateResponseBodySchema.parse({
      model: "m", input: "hi", tools: ["web_search_preview"],
    });
    const { activeTools } = resolveActiveTools(parsed.tools, "auto");
    expect(activeTools).toHaveProperty("web_search");
  });

  test("resolves function tools alongside builtin tools", () => {
    const tools = [
      { type: "web_search" },
      { type: "function", name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
    ];
    const { activeTools, hasFunctionTools, hasBuiltinTools } = resolveActiveTools(tools, "auto");
    expect(activeTools).toHaveProperty("web_search");
    expect(activeTools).toHaveProperty("get_weather");
    expect(hasFunctionTools).toBe(true);
    expect(hasBuiltinTools).toBe(true);
  });

  test("resolves function tools only when no builtin tools", () => {
    const tools = [
      { type: "function", name: "calculate", parameters: { type: "object" } },
    ];
    const { activeTools, hasFunctionTools, hasBuiltinTools } = resolveActiveTools(tools, "auto");
    expect(activeTools).toHaveProperty("calculate");
    expect(activeTools).not.toHaveProperty("web_search");
    expect(hasFunctionTools).toBe(true);
    expect(hasBuiltinTools).toBe(false);
  });

  test("toolChoice 'none' disables function tools too", () => {
    const tools = [{ type: "function", name: "f1" }];
    const { activeTools, hasFunctionTools } = resolveActiveTools(tools, "none");
    expect(Object.keys(activeTools)).toHaveLength(0);
    expect(hasFunctionTools).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildOutputConfig
// ---------------------------------------------------------------------------

describe("buildOutputConfig", () => {
  test("returns text output for null config", () => {
    const config = buildOutputConfig(null);
    expect(config.usesStructuredOutput).toBe(false);
    expect(config.output).toBeDefined();
  });

  test("returns text output for plain text format", () => {
    const config = buildOutputConfig({ format: { type: "text" } });
    expect(config.usesStructuredOutput).toBe(false);
    expect(config.output).toBeDefined();
  });

  test("returns structured output for json format", () => {
    const config = buildOutputConfig({ format: { type: "json" } });
    expect(config.usesStructuredOutput).toBe(true);
    expect(config.output).toBeDefined();
  });

  test("returns structured output for json_schema with schema", () => {
    const config = buildOutputConfig({
      format: {
        type: "json_schema",
        json_schema: { name: "test", schema: { type: "object", properties: { name: { type: "string" } } } },
      },
    });
    expect(config.usesStructuredOutput).toBe(true);
    expect(config.output).toBeDefined();
  });

  test("falls back to text when json_schema has no schema", () => {
    const config = buildOutputConfig({ format: { type: "json_schema" } });
    expect(config.usesStructuredOutput).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveResponseText
// ---------------------------------------------------------------------------

describe("resolveResponseText", () => {
  test("stringifies output when structured output is used", () => {
    const obj = { name: "test", value: 42 };
    const result = resolveResponseText("ignored", () => obj, true);
    expect(result).toBe(JSON.stringify(obj));
  });

  test("returns text when structured but output is undefined", () => {
    expect(resolveResponseText("fallback", () => undefined, true)).toBe("fallback");
  });

  test("falls back to text when output getter throws (NoOutputGeneratedError)", () => {
    const throwing = () => { throw new Error("No output generated."); };
    expect(resolveResponseText("fallback text", throwing, true)).toBe("fallback text");
  });

  test("does not call output getter when not structured output", () => {
    let called = false;
    const getter = () => { called = true; throw new Error("should not be called"); };
    expect(resolveResponseText("hello", getter, false)).toBe("hello");
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatUsage
// ---------------------------------------------------------------------------

describe("formatUsage", () => {
  test("returns null for null input", () => {
    expect(formatUsage(null)).toBeNull();
  });

  test("normalises AI-SDK style usage", () => {
    const result = formatUsage({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(result).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  test("normalises OpenAI snake_case style usage", () => {
    const result = formatUsage({ prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 });
    expect(result).toEqual({
      input_tokens: 5,
      output_tokens: 15,
      total_tokens: 20,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  test("computes total when not provided", () => {
    const result = formatUsage({ inputTokens: 7, outputTokens: 3 });
    expect(result!.total_tokens).toBe(10);
  });

  test("prefers inputTokens over promptTokens", () => {
    const result = formatUsage({ inputTokens: 100, promptTokens: 50 });
    expect(result!.input_tokens).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// createResponseObject
// ---------------------------------------------------------------------------

describe("createResponseObject", () => {
  test("builds a response with completed status", () => {
    const resp = createResponseObject(makeParams({ status: "completed" }));
    expect(resp.id).toBe("resp_001");
    expect(resp.object).toBe("response");
    expect(resp.status).toBe("completed");
    expect(resp.completed_at).toBeGreaterThan(0);
    expect(resp.error).toBeNull();
    expect(resp.model).toBe("test-model");
  });

  test("sets completed_at to null for in_progress status", () => {
    const resp = createResponseObject(makeParams({ status: "in_progress" }));
    expect(resp.status).toBe("in_progress");
    expect(resp.completed_at).toBeNull();
  });

  test("formats usage when provided", () => {
    const resp = createResponseObject(makeParams({ usage: { inputTokens: 10, outputTokens: 5 } }));
    expect(resp.usage).not.toBeNull();
    expect(resp.usage!.input_tokens).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// markResponseFailed
// ---------------------------------------------------------------------------

describe("markResponseFailed", () => {
  test("sets status to failed with error payload", () => {
    const original = createResponseObject(makeParams({ status: "completed" }));
    const failed = markResponseFailed(original, "Something went wrong");
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({ code: "server_error", message: "Something went wrong" });
  });

  test("does not mutate the original object", () => {
    const original = createResponseObject(makeParams({ status: "completed" }));
    markResponseFailed(original, "err");
    expect(original.status).toBe("completed");
    expect(original.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractSearchAnnotations
// ---------------------------------------------------------------------------

describe("extractSearchAnnotations", () => {
  test("extracts URL citations from web_search results", () => {
    const results: ToolResultData[] = [
      {
        toolCallId: "tc_1",
        toolName: "web_search",
        args: {},
        result: {
          results: [
            { url: "https://example.com", title: "Example" },
            { url: "https://test.com", title: "Test" },
          ],
        },
      },
    ];
    const annotations = extractSearchAnnotations(results);
    expect(annotations).toHaveLength(2);
    expect(annotations[0]).toEqual({ type: "url_citation", url: "https://example.com", title: "Example" });
    expect(annotations[1]).toEqual({ type: "url_citation", url: "https://test.com", title: "Test" });
  });

  test("ignores non-web_search tool results", () => {
    const results: ToolResultData[] = [
      { toolCallId: "tc_1", toolName: "web_fetch", args: {}, result: { results: [{ url: "https://x.com" }] } },
    ];
    const annotations = extractSearchAnnotations(results);
    expect(annotations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildOutputItems
// ---------------------------------------------------------------------------

describe("buildOutputItems", () => {
  test("builds message-only output when no tool calls", () => {
    const items = buildOutputItems("resp_1", "Hello!", [], []);
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("message");
    const msg = items[0] as MessageOutputItem;
    expect(msg.id).toBe("msg_resp_1");
    expect((msg.content[0] as { text: string }).text).toBe("Hello!");
  });

  test("includes tool call items before the message", () => {
    const toolCalls: ToolCallItem[] = [
      { id: "call_abc", aiToolCallId: "tc_1", type: "web_search_call", status: "completed" },
    ];
    const toolResults: ToolResultData[] = [
      { toolCallId: "tc_1", toolName: "web_search", args: { query: "test" }, result: { results: [] } },
    ];
    const items = buildOutputItems("resp_1", "Result", toolCalls, toolResults);
    expect(items).toHaveLength(2);
    expect(items[0]!.type).toBe("web_search_call");
    expect(items[1]!.type).toBe("message");
  });

  test("always populates action.type and action.query on web_search_call items", () => {
    const toolCalls: ToolCallItem[] = [
      { id: "call_abc", aiToolCallId: "tc_1", type: "web_search_call", status: "completed" },
    ];
    const toolResults: ToolResultData[] = [
      { toolCallId: "tc_1", toolName: "web_search", args: { query: "climate change" }, result: { results: [] } },
    ];
    const items = buildOutputItems("resp_1", "text", toolCalls, toolResults);
    const searchItem = items[0] as any;
    expect(searchItem.action).toBeDefined();
    expect(searchItem.action.type).toBe("search");
    expect(searchItem.action.query).toBe("climate change");
  });

  test("includes web_search_call.results when requested via include", () => {
    const toolCalls: ToolCallItem[] = [
      { id: "call_abc", aiToolCallId: "tc_1", type: "web_search_call", status: "completed" },
    ];
    const toolResults: ToolResultData[] = [
      { toolCallId: "tc_1", toolName: "web_search", args: {}, result: { results: [{ url: "https://x.com", title: "X" }] } },
    ];
    const items = buildOutputItems("resp_1", "text", toolCalls, toolResults, ["web_search_call.results"]);
    const searchItem = items[0] as any;
    expect(searchItem.results).toBeDefined();
    expect(searchItem.results).toHaveLength(1);
  });

  test("includes web_search_call.action.sources when requested alongside type and query", () => {
    const toolCalls: ToolCallItem[] = [
      { id: "call_abc", aiToolCallId: "tc_1", type: "web_search_call", status: "completed" },
    ];
    const toolResults: ToolResultData[] = [
      { toolCallId: "tc_1", toolName: "web_search", args: { query: "test" }, result: { results: [{ url: "https://x.com", title: "X" }] } },
    ];
    const items = buildOutputItems("resp_1", "text", toolCalls, toolResults, ["web_search_call.action.sources"]);
    const searchItem = items[0] as any;
    expect(searchItem.action.type).toBe("search");
    expect(searchItem.action.query).toBe("test");
    expect(searchItem.action.sources).toHaveLength(1);
    expect(searchItem.action.sources[0]).toEqual({ type: "url_citation", url: "https://x.com", title: "X" });
  });

  test("adds search annotations to message content", () => {
    const toolResults: ToolResultData[] = [
      { toolCallId: "tc_1", toolName: "web_search", args: {}, result: { results: [{ url: "https://a.com", title: "A" }] } },
    ];
    const items = buildOutputItems("resp_1", "Answer", [], toolResults);
    const msg = items[0] as any;
    expect(msg.content[0].annotations).toHaveLength(1);
    expect(msg.content[0].annotations[0].url).toBe("https://a.com");
  });

  test("builds function_call output items", () => {
    const toolCalls: ToolCallItem[] = [
      {
        id: "call_abc", aiToolCallId: "tc_1", type: "function_call", status: "completed",
        name: "get_weather", callId: "tc_1", arguments: '{"city":"Berlin"}',
      },
    ];
    const items = buildOutputItems("resp_1", "", toolCalls, []);
    expect(items).toHaveLength(2); // function_call + message
    expect(items[0]!.type).toBe("function_call");
    const fc = items[0] as any;
    expect(fc.name).toBe("get_weather");
    expect(fc.call_id).toBe("tc_1");
    expect(fc.arguments).toBe('{"city":"Berlin"}');
    expect(fc.status).toBe("completed");
  });

  test("builds mixed web_search_call and function_call output", () => {
    const toolCalls: ToolCallItem[] = [
      { id: "call_1", aiToolCallId: "tc_1", type: "web_search_call", status: "completed" },
      { id: "call_2", aiToolCallId: "tc_2", type: "function_call", status: "completed", name: "calc", callId: "tc_2", arguments: "{}" },
    ];
    const toolResults: ToolResultData[] = [
      { toolCallId: "tc_1", toolName: "web_search", args: { query: "q" }, result: { results: [] } },
    ];
    const items = buildOutputItems("resp_1", "Answer", toolCalls, toolResults);
    expect(items).toHaveLength(3);
    expect(items[0]!.type).toBe("web_search_call");
    expect(items[1]!.type).toBe("function_call");
    expect(items[2]!.type).toBe("message");
  });
});

// ---------------------------------------------------------------------------
// parseFunctionTools
// ---------------------------------------------------------------------------

describe("parseFunctionTools", () => {
  test("extracts function tool definitions from mixed tools array", () => {
    const tools = [
      { type: "web_search" },
      { type: "function", name: "get_weather", description: "Get weather info", parameters: { type: "object" } },
      { type: "function", name: "calculate", parameters: { type: "object", properties: { expr: { type: "string" } } } },
    ];
    const result = parseFunctionTools(tools);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("get_weather");
    expect(result[0]!.description).toBe("Get weather info");
    expect(result[1]!.name).toBe("calculate");
  });

  test("ignores non-function tools", () => {
    const tools = [{ type: "web_search" }, { type: "unknown" }, "web_search"];
    const result = parseFunctionTools(tools);
    expect(result).toHaveLength(0);
  });

  test("returns empty for non-array input", () => {
    expect(parseFunctionTools(null as any)).toEqual([]);
    expect(parseFunctionTools(undefined as any)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildFunctionToolSet
// ---------------------------------------------------------------------------

describe("buildFunctionToolSet", () => {
  test("creates AI SDK tool objects without execute", () => {
    const defs = [
      { type: "function" as const, name: "greet", description: "Say hello", parameters: { type: "object", properties: { name: { type: "string" } } } },
    ];
    const toolSet = buildFunctionToolSet(defs);
    expect(toolSet).toHaveProperty("greet");
    // Manual tools should not have an execute function
    expect((toolSet["greet"] as any).execute).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildStepOutputItems
// ---------------------------------------------------------------------------

describe("buildStepOutputItems", () => {
  test("returns empty array when stepToolCalls is undefined", () => {
    expect(buildStepOutputItems(undefined, undefined)).toEqual([]);
  });

  test("builds web_search_call item with query from args", () => {
    const toolCalls = [{ toolCallId: "tc_1", toolName: "web_search", input: { query: "Berlin weather" } }];
    const toolResults = [{ toolCallId: "tc_1", toolName: "web_search", input: { query: "Berlin weather" }, output: { query: "Berlin weather", results: [{ url: "https://example.com", title: "Weather" }] } }];
    const items = buildStepOutputItems(toolCalls, toolResults);

    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("web_search_call");
    const search = items[0] as any;
    expect(search.status).toBe("completed");
    expect(search.action.type).toBe("search");
    expect(search.action.query).toBe("Berlin weather");
    expect(search.id).toStartWith("call_");
  });

  test("filters out internal tools (web_fetch)", () => {
    const toolCalls = [
      { toolCallId: "tc_1", toolName: "web_search" },
      { toolCallId: "tc_2", toolName: "web_fetch" },
    ];
    const items = buildStepOutputItems(toolCalls, []);
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("web_search_call");
  });

  test("builds function_call item for user-defined tools", () => {
    const toolCalls = [{ toolCallId: "tc_1", toolName: "get_weather", input: { city: "Berlin" } }];
    const items = buildStepOutputItems(toolCalls, []);

    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("function_call");
    const fc = items[0] as any;
    expect(fc.name).toBe("get_weather");
    expect(fc.call_id).toBe("tc_1");
    expect(fc.arguments).toBe('{"city":"Berlin"}');
  });

  test("includes results when web_search_call.results is in include", () => {
    const toolCalls = [{ toolCallId: "tc_1", toolName: "web_search", input: { query: "test" } }];
    const toolResults = [{ toolCallId: "tc_1", toolName: "web_search", input: { query: "test" }, output: { results: [{ url: "https://x.com", title: "X" }] } }];
    const items = buildStepOutputItems(toolCalls, toolResults, ["web_search_call.results"]);

    const search = items[0] as any;
    expect(search.results).toBeDefined();
    expect(search.results).toHaveLength(1);
    expect(search.results[0].url).toBe("https://x.com");
  });

  test("omits results when include is empty", () => {
    const toolCalls = [{ toolCallId: "tc_1", toolName: "web_search" }];
    const toolResults = [{ toolCallId: "tc_1", toolName: "web_search", input: {}, output: { results: [{ url: "https://x.com" }] } }];
    const items = buildStepOutputItems(toolCalls, toolResults);

    const search = items[0] as any;
    expect(search.results).toBeUndefined();
  });

  test("skips entries with empty toolCallId", () => {
    const toolCalls = [{ toolCallId: "", toolName: "web_search" }];
    expect(buildStepOutputItems(toolCalls, [])).toEqual([]);
  });
});
