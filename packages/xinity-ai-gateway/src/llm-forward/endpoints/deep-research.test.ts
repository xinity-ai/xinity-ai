import { describe, test, expect, mock, beforeAll, afterAll, afterEach } from "bun:test";
import { setupResponseTestMocks, waitForResponseStatus, mockBackendFetch, makeChatJsonResponseWithToolCalls, makeChatJsonResponse } from "./test-helpers";

const mocks = setupResponseTestMocks();
const { getModelInfo, responseStore } = mocks;
mockBackendFetch();

mock.module("../tools/web-fetch", () => ({
  fetchWebContent: async (url: string) => ({
    url,
    content: "Weather data for Berlin showing temperatures and conditions.",
    truncated: false,
    contentType: "text/html",
  }),
}));

const { setSearchProvider } = await import("../tools/response-tools");
const { handleCreateResponseRequest, handleCancelResponseRequest } = await import("./handle-responses");

let server: any;
let capturedRequests: Array<{ messages: any[]; hasTools: boolean }> = [];
let serverGate: Promise<void> | null = null;
let serverUsageOverride: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

beforeAll(() => {
  setSearchProvider({
    search: async () => [
      { title: "Berlin Weather", url: "https://weather.example.com/berlin", content: "Berlin has a temperate transitional climate." },
    ],
  });

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/chat/completions") {
        if (serverGate) {
          await serverGate;
        }

        const body = await req.json() as any;
        capturedRequests.push({ messages: body.messages, hasTools: !!body.tools?.length });

        if (!body.tools?.length) {
          return makeChatJsonResponse("test-model", "Summary of research findings so far.");
        }

        const toolResultCount = (body.messages as any[]).filter((m: any) => m.role === "tool").length;

        const usage = serverUsageOverride ?? undefined;

        if (toolResultCount === 0) {
          return makeChatJsonResponseWithToolCalls("test-model", [
            { id: "call_ws1", name: "web_search", arguments: '{"query":"Berlin weather 2024"}' },
          ], usage);
        }
        if (toolResultCount === 1) {
          return makeChatJsonResponseWithToolCalls("test-model", [
            { id: "call_wf1", name: "web_fetch", arguments: '{"url":"https://weather.example.com/berlin"}' },
          ], usage);
        }
        return makeChatJsonResponse("test-model", "Berlin is the capital of Germany, with a population of over 3.6 million.");
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  mocks.setMockPort(server.port);
});

afterAll(() => {
  server.stop();
  setSearchProvider(null);
});

afterEach(() => {
  mocks.clearAll();
  capturedRequests = [];
  serverGate = null;
  serverUsageOverride = null;
});

describe("deep research", () => {
  test("returns 202 and completes with web_search + final text", async () => {
    const res = await handleCreateResponseRequest(new Request("http://localhost:4000/v1/responses", {
      method: "POST", headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "llama-3.1-8b-instruct-deep-research", input: "Tell me about Berlin" }),
    }));

    expect(res.status).toBe(202);
    const body = await res.json() as any;

    const completed = await waitForResponseStatus(responseStore, body.id, "completed");
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe("completed");

    const searchItem = completed!.output?.find((item: any) => item.type === "web_search_call");
    expect(searchItem).toBeDefined();
    expect(searchItem.status).toBe("completed");
    expect(searchItem.action?.query).toBe("Berlin weather 2024");

    const msgItem = completed!.output?.find((item: any) => item.type === "message");
    expect(msgItem).toBeDefined();
    expect(msgItem.role).toBe("assistant");
    expect(msgItem.content?.[0]?.text).toContain("Berlin");

    expect(completed!.usage).toBeDefined();
  });

  test("appends custom instructions from body", async () => {
    const res = await handleCreateResponseRequest(new Request("http://localhost:4000/v1/responses", {
      method: "POST", headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "llama-3.1-8b-instruct-deep-research", input: "Tell me about Berlin", instructions: "Focus on 2023 data." }),
    }));

    expect(res.status).toBe(202);
    const body = await res.json() as any;
    await waitForResponseStatus(responseStore, body.id, "completed");

    const firstRequest = capturedRequests[0];
    expect(firstRequest).toBeDefined();
    const systemMsg = firstRequest!.messages.find((m: any) => m.role === "system");
    expect(systemMsg?.content).toContain("Focus on 2023 data.");
  });

  test("cancels deep research while running", async () => {
    let resolveGate!: () => void;
    serverGate = new Promise((r) => { resolveGate = r; });

    const res = await handleCreateResponseRequest(new Request("http://localhost:4000/v1/responses", {
      method: "POST", headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "llama-3.1-8b-instruct-deep-research", input: "Tell me about Berlin" }),
    }));

    expect(res.status).toBe(202);
    const body = await res.json() as any;

    const cancelResp = await handleCancelResponseRequest(new Request(
      `http://localhost:4000/v1/responses/${body.id}/cancel`,
      { method: "POST", headers: { "Authorization": "Bearer test" } },
    ));
    expect(cancelResp.status).toBe(200);

    resolveGate();
    await new Promise((r) => setTimeout(r, 50));

    const stored = responseStore.get(body.id);
    expect(stored?.status).toBe("cancelled");
  });

  test("includes search results when include: ['web_search_call.results']", async () => {
    const res = await handleCreateResponseRequest(new Request("http://localhost:4000/v1/responses", {
      method: "POST", headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "llama-3.1-8b-instruct-deep-research", input: "Tell me about Berlin", include: ["web_search_call.results"] }),
    }));

    expect(res.status).toBe(202);
    const body = await res.json() as any;
    const completed = await waitForResponseStatus(responseStore, body.id, "completed");
    expect(completed).not.toBeNull();

    const searchItem = completed!.output?.find((o: any) => o.type === "web_search_call");
    expect(searchItem).toBeDefined();
    expect(searchItem.results).toBeDefined();
    expect(searchItem.results?.[0]?.url).toBe("https://weather.example.com/berlin");

    const msgItem = completed!.output?.find((item: any) => item.type === "message");
    const textPart = msgItem.content?.[0] as any;
    expect(textPart.annotations?.some((a: any) => a.type === "url_citation")).toBe(true);
  });

  test("rejects streaming deep research", async () => {
    const res = await handleCreateResponseRequest(new Request("http://localhost:4000/v1/responses", {
      method: "POST", headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "llama-3.1-8b-instruct-deep-research", input: "Tell me about Berlin", stream: true }),
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.message).toContain("Streaming is not supported");
  });

  test("rejects when model lacks tool support", async () => {
    getModelInfo.mockImplementationOnce(async () => ({
      nodeId: "node-1", host: `localhost:${server.port}`, specifier: "test-model", model: "test-model",
      driver: "vllm", authToken: null, tls: false, tags: [],
      maxContextLength: 131072, release: () => {},
    }));

    const res = await handleCreateResponseRequest(new Request("http://localhost:4000/v1/responses", {
      method: "POST", headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "test-model-deep-research", input: "Tell me about Berlin" }),
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.message).toContain("no");
  });

  test("triggers context compaction when usage exceeds threshold", async () => {
    serverUsageOverride = { prompt_tokens: 50000, completion_tokens: 30000, total_tokens: 80000 };

    const res = await handleCreateResponseRequest(new Request("http://localhost:4000/v1/responses", {
      method: "POST", headers: { "Authorization": "Bearer test" },
      body: JSON.stringify({ model: "llama-3.1-8b-instruct-deep-research", input: "Tell me about Berlin" }),
    }));

    expect(res.status).toBe(202);
    const body = await res.json() as any;
    const completed = await waitForResponseStatus(responseStore, body.id, "completed");
    expect(completed).not.toBeNull();

    const compactionRequests = capturedRequests.filter((r) => !r.hasTools);
    expect(compactionRequests.length).toBeGreaterThan(0);

    const compactionMsg = compactionRequests[0]!.messages.find((m: any) =>
      m.role === "system" && m.content?.includes("summarizing an in-progress research session"),
    );
    expect(compactionMsg).toBeDefined();
  });
});
