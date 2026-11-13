import { describe, test, expect, spyOn, afterEach, afterAll } from "bun:test";

import { rootLogger } from "../logger";
import * as usageRecorder from "../usageRecorder";
import { BackendChatChunkSchema } from "./backend-schemas";
import { makeChatSseChunksWithUsage, makeControlledSseStream, SSE_PROMPT_TOKENS, type SseStreamEnd } from "./endpoints/test-helpers";

// One mock call is one usage_event row.
const recordUsageEvent = spyOn(usageRecorder, "recordUsageEvent").mockImplementation(() => {});
afterEach(() => recordUsageEvent.mockClear());
afterAll(() => recordUsageEvent.mockRestore());

const { isStandardStreamingChunk, forwardOpenAIStream } = await import("./openai-forward");

describe("isStandardStreamingChunk fast-path shape check", () => {
  test("accepts standard chat delta chunk", () => {
    const validChatChunk = {
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "backend-model",
      choices: [
        {
          index: 0,
          delta: { content: "Hello", role: "assistant" },
          finish_reason: null,
        },
      ],
    };
    expect(isStandardStreamingChunk(validChatChunk)).toBe(true);
  });

  test("accepts standard completion text chunk", () => {
    const validCompChunk = {
      id: "cmpl-123",
      object: "text_completion",
      created: 1700000000,
      model: "backend-model",
      choices: [
        {
          index: 0,
          text: " world",
          finish_reason: null,
        },
      ],
    };
    expect(isStandardStreamingChunk(validCompChunk)).toBe(true);
  });

  test("accepts usage-only chunk with valid usage", () => {
    const usageChunk = {
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "backend-model",
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    };
    expect(isStandardStreamingChunk(usageChunk)).toBe(true);
  });

  test("rejects tool-call chunks to ensure Zod normalizes null fields", () => {
    const toolCallChunk = {
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "backend-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: null, type: null, function: { name: "search", arguments: "{}" } }],
          },
        },
      ],
    };
    expect(isStandardStreamingChunk(toolCallChunk)).toBe(false);
  });

  test("rejects malformed choices or junk usage", () => {
    expect(isStandardStreamingChunk(null)).toBe(false);
    expect(isStandardStreamingChunk("string")).toBe(false);
    expect(isStandardStreamingChunk({ id: "123", created: 123, choices: "not-an-array" })).toBe(false);
    expect(isStandardStreamingChunk({ id: "123", created: 123, choices: [{ index: "invalid" }] })).toBe(false);
    expect(isStandardStreamingChunk({ id: "123", created: 123, choices: [], usage: { prompt_tokens: "bad" } })).toBe(false);
  });
});

describe("forwardOpenAIStream", () => {
  const log = rootLogger.child({ name: "openai-forward-test" });
  const warn = spyOn(log, "warn");

  const dummyLogFields = {
    auth: { keyId: "k", orgId: "o", applicationId: null, collectData: false },
    modelInfo: { model: "m" },
    publicSpecifier: "pub-m",
    endpoint: "chat_completions" as const,
    inputMessages: [],
    callStartTime: Date.now(),
  };

  const chatSpec = {
    chunkSchema: BackendChatChunkSchema,
    initAcc: () => ({ text: "" }),
    applyChoice: (acc: { text: string }, choice: any) => {
      if (choice.delta?.content) acc.text += choice.delta.content;
    },
    toLogEntry: (acc: { text: string }, index: number, model: string) => ({
      model,
      choices: [{ index, delta: { role: "assistant", content: acc.text } }],
    }),
  };

  test("streams fast-path chunks, overwriting model and forwarding SSE", async () => {
    const sseBody = [
      `data: ${JSON.stringify({ id: "c1", created: 1, object: "chat.completion.chunk", model: "backend-model", choices: [{ index: 0, delta: { content: "Hello " } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c2", created: 2, object: "chat.completion.chunk", model: "backend-model", choices: [{ index: 0, delta: { content: "World!" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    const backendResponse = new Response(sseBody, {
      headers: { "Content-Type": "text/event-stream" },
    });

    const forwardResponse = forwardOpenAIStream({
      backendResponse,
      originalModel: "public-model",
      includeUsage: false,
      spec: chatSpec,
      logFields: dummyLogFields,
      log,
    });

    const text = await forwardResponse.text();
    expect(text).toContain('"model":"public-model"');
    expect(text).toContain("Hello ");
    expect(text).toContain("World!");
    expect(text).toContain("data: [DONE]\n\n");
  });

  test("forwards unrecognized/unparseable chunk unlogged without failing stream", async () => {
    const sseBody = [
      `data: ${JSON.stringify({ unmodeled_field: true, choices: [{ index: "invalid_type" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    const backendResponse = new Response(sseBody, {
      headers: { "Content-Type": "text/event-stream" },
    });

    const forwardResponse = forwardOpenAIStream({
      backendResponse,
      originalModel: "public-model",
      includeUsage: false,
      spec: chatSpec,
      logFields: dummyLogFields,
      log,
    });

    const text = await forwardResponse.text();
    expect(text).toContain('"unmodeled_field":true');
    expect(warn).toHaveBeenCalled();
  });

  function streamEndingIn(errorFrame: object): Promise<string> {
    const sseBody = [
      `data: ${JSON.stringify({ id: "c1", created: 1, object: "chat.completion.chunk", model: "backend-model", choices: [{ index: 0, delta: { content: "Hel" } }] })}\n\n`,
      `data: ${JSON.stringify({ error: errorFrame })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return forwardOpenAIStream({
      backendResponse: new Response(sseBody, { headers: { "Content-Type": "text/event-stream" } }),
      originalModel: "public-model",
      includeUsage: false,
      spec: {
        ...chatSpec,
        synthesizeFinal: (_acc, index, template) => ({ ...template, choices: [{ index, delta: {}, finish_reason: "stop" }] }),
      },
      logFields: dummyLogFields,
      log,
    }).text();
  }

  test("ends the stream with a reference instead of the engine's message when the backend fails mid-stream", async () => {
    const text = await streamEndingIn({ message: "CUDA out of memory on GPU 0", type: "InternalServerError", param: null, code: 500 });

    expect(text).toMatch(/"type":"server_error"/);
    expect(text).toMatch(/reference [0-9a-f-]{36}/);
    expect(text).not.toContain("CUDA");
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(text).toEndWith("data: [DONE]\n\n");
  });

  test("passes a request error from the backend through as it was reported", async () => {
    const text = await streamEndingIn({ message: "temperature must be non-negative", type: "BadRequestError", param: "temperature", code: 400 });

    expect(text).toEndWith(
      `data: ${JSON.stringify({ error: { message: "temperature must be non-negative", type: "invalid_request_error", param: "temperature" } })}\n\ndata: [DONE]\n\n`,
    );
  });

  test("treats an error frame without a code as a server failure", async () => {
    const text = await streamEndingIn({ message: "something internal" });

    expect(text).toMatch(/"type":"server_error"/);
    expect(text).not.toContain("something internal");
  });
});

describe("forwardOpenAIStream usage recording", () => {
  const log = rootLogger.child({ name: "openai-forward-usage-test" });

  const logFields = {
    auth: { keyId: "k", orgId: "o", applicationId: null, collectData: false },
    modelInfo: { model: "m" },
    publicSpecifier: "pub-m",
    endpoint: "chat_completions" as const,
    inputMessages: [],
    callStartTime: Date.now(),
  };

  const chatSpec = {
    chunkSchema: BackendChatChunkSchema,
    initAcc: () => ({ text: "" }),
    applyChoice: (acc: { text: string }, choice: any) => {
      if (choice.delta?.content) acc.text += choice.delta.content;
    },
    toLogEntry: (acc: { text: string }, index: number, model: string) => ({
      model,
      choices: [{ index, delta: { role: "assistant", content: acc.text } }],
    }),
  };

  const CONTENT = ["a", "b", "c", "d", "e"];

  function forward(stream: ReadableStream<Uint8Array>, includeUsage = false): Response {
    return forwardOpenAIStream({
      backendResponse: new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
      originalModel: "public-model",
      includeUsage,
      spec: chatSpec,
      logFields,
      log,
    });
  }

  function forwardChunks(chunks: string[], end: SseStreamEnd, includeUsage = false): Promise<string> {
    return forward(makeControlledSseStream(chunks, end).stream, includeUsage).text();
  }

  function rows() {
    return recordUsageEvent.mock.calls.map(([row]) => row);
  }

  async function waitForRows(count: number): Promise<void> {
    const deadline = Date.now() + 1000;
    while (recordUsageEvent.mock.calls.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function dataEvents(text: string): any[] {
    return text.split("\n\n")
      .filter((event) => event.startsWith("data: ") && event !== "data: [DONE]")
      .map((event) => JSON.parse(event.slice("data: ".length)));
  }

  test("client abort after 3 chunks records the usage of chunk 3 as a success", async () => {
    const chunks = makeChatSseChunksWithUsage("backend-model", CONTENT).slice(0, 3);
    await forwardChunks(chunks, "abort");

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ success: true, logged: false, inputTokens: SSE_PROMPT_TOKENS, outputTokens: 3 });
  });

  test("client cancel records exactly one row when the next enqueue fails", async () => {
    const chunks = makeChatSseChunksWithUsage("backend-model", CONTENT);
    const { stream, release } = makeControlledSseStream(chunks, "done", { gateAfter: 2 });
    const reader = forward(stream).body!.getReader();

    await reader.read();
    await reader.read();
    await reader.cancel();
    release();
    await waitForRows(1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ success: true, inputTokens: SSE_PROMPT_TOKENS, outputTokens: 3 });
  });

  test("a stream without [DONE] records a failure with the usage of the last chunk", async () => {
    const chunks = makeChatSseChunksWithUsage("backend-model", CONTENT).slice(0, 4);
    await forwardChunks(chunks, "cut");

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ success: false, inputTokens: SSE_PROMPT_TOKENS, outputTokens: 4 });
  });

  test("a backend error event mid-stream records a failure with the last usage", async () => {
    const chunks = [
      ...makeChatSseChunksWithUsage("backend-model", CONTENT).slice(0, 2),
      `data: ${JSON.stringify({ error: { message: "engine died", code: 500 } })}\n\n`,
    ];
    await forwardChunks(chunks, "done");

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ success: false, inputTokens: SSE_PROMPT_TOKENS, outputTokens: 2 });
  });

  test("an idle timeout records a failure with the last usage", async () => {
    const chunks = makeChatSseChunksWithUsage("backend-model", CONTENT).slice(0, 2);
    await forwardChunks(chunks, "timeout");

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ success: false, inputTokens: SSE_PROMPT_TOKENS, outputTokens: 2 });
  });

  test("[DONE] records the usage of the final usage-only chunk", async () => {
    const chunks = makeChatSseChunksWithUsage("backend-model", CONTENT, { finalUsageChunk: true });
    chunks[chunks.length - 1] = chunks.at(-1)!.replace(`"completion_tokens":${CONTENT.length}`, `"completion_tokens":9`);
    await forwardChunks(chunks, "done");

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ success: true, inputTokens: SSE_PROMPT_TOKENS, outputTokens: 9 });
  });

  test("without include_usage, no forwarded chunk has usage", async () => {
    const chunks = makeChatSseChunksWithUsage("backend-model", CONTENT, { finalUsageChunk: true });
    const events = dataEvents(await forwardChunks(chunks, "done", false));

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => "usage" in event)).toBe(false);
    expect(events.some((event) => event.choices.length === 0)).toBe(false);
  });

  test("with include_usage, only the one usage-only chunk has usage", async () => {
    const chunks = makeChatSseChunksWithUsage("backend-model", CONTENT, { finalUsageChunk: true });
    const events = dataEvents(await forwardChunks(chunks, "done", true));

    const withUsage = events.filter((event) => "usage" in event);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0].choices).toEqual([]);
    expect(withUsage[0].usage.completion_tokens).toBe(CONTENT.length);
  });

  test("usage on the finish_reason chunk gives the client one usage-only chunk with that usage", async () => {
    const chunks = makeChatSseChunksWithUsage("backend-model", CONTENT);
    const events = dataEvents(await forwardChunks(chunks, "done", true));

    const withUsage = events.filter((event) => "usage" in event);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0]).toMatchObject({ id: "test-id", model: "public-model", choices: [] });
    expect(withUsage[0].usage).toEqual({
      prompt_tokens: SSE_PROMPT_TOKENS,
      completion_tokens: CONTENT.length,
      total_tokens: SSE_PROMPT_TOKENS + CONTENT.length,
    });
    expect(events.at(-1)).toBe(withUsage[0]);
  });

  test("a backend without per-chunk usage records 0/0 on abort", async () => {
    const chunks = CONTENT.slice(0, 3).map((content) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "backend-model", choices: [{ index: 0, delta: { content } }] })}\n\n`);
    await forwardChunks(chunks, "abort");

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ success: true, inputTokens: 0, outputTokens: 0 });
  });
});
