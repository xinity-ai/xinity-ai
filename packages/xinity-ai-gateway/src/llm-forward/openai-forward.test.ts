import { describe, test, expect, spyOn } from "bun:test";

import { rootLogger } from "../logger";
import { BackendChatChunkSchema } from "./backend-schemas";
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
