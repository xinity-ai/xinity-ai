import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";

let mockPort: number = 0;

mock.module("../model-registry", () => ({
  resolveModel: (model: string) => {
    if (model === "llama3:latest") return { port: mockPort, driver: "ollama" };
    if (model === "meta-llama/Llama-3.1-8B") return { port: mockPort, driver: "vllm" };
    if (model === "dead-backend") return { port: 1, driver: "vllm" };
    return undefined;
  },
}));

import { getAuthToken } from "../statekeeper";
const { handleProxyRequest } = await import("./proxy");

let server: ReturnType<typeof Bun.serve>;
let lastUpstreamRequest: { method: string; path: string; body: unknown } | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method !== "GET" ? await req.json().catch(() => null) : null;
      lastUpstreamRequest = { method: req.method, path: url.pathname + url.search, body };

      if (url.pathname === "/v1/chat/completions") {
        return Response.json({ id: "chatcmpl-1", choices: [], model: "llama3:latest" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  mockPort = server.port;
});

afterAll(() => {
  server.stop(true);
});

function proxyRequest(path: string, options?: { method?: string; body?: unknown; token?: string | null }) {
  const method = options?.method ?? "POST";
  const token = options?.token === undefined ? getAuthToken() : options.token;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  const url = new URL(path, "http://localhost");
  const req = new Request(url.toString(), {
    method,
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  return handleProxyRequest(req, url);
}

describe("proxy auth", () => {
  test("rejects missing auth token", async () => {
    const res = await proxyRequest("/proxy/llama3%3Alatest/v1/chat/completions", { token: null });
    expect(res.status).toBe(401);
  });

  test("rejects wrong auth token", async () => {
    const res = await proxyRequest("/proxy/llama3%3Alatest/v1/chat/completions", { token: "wrong" });
    expect(res.status).toBe(401);
  });

  test("accepts valid auth token", async () => {
    const res = await proxyRequest("/proxy/llama3%3Alatest/v1/chat/completions", {
      body: { model: "llama3:latest", messages: [] },
    });
    expect(res.status).toBe(200);
  });
});

describe("proxy routing", () => {
  test("returns 400 for invalid proxy path", async () => {
    const res = await proxyRequest("/proxy/");
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown model", async () => {
    const res = await proxyRequest("/proxy/nonexistent/v1/chat/completions");
    expect(res.status).toBe(404);
  });

  test("decodes URL-encoded model names", async () => {
    const res = await proxyRequest("/proxy/llama3%3Alatest/v1/chat/completions", {
      body: { model: "llama3:latest", messages: [] },
    });
    expect(res.status).toBe(200);
  });

  test("handles model names with encoded slashes", async () => {
    const res = await proxyRequest("/proxy/meta-llama%2FLlama-3.1-8B/v1/chat/completions", {
      body: { model: "meta-llama/Llama-3.1-8B", messages: [] },
    });
    expect(res.status).toBe(200);
  });

  test("forwards query string to backend", async () => {
    lastUpstreamRequest = null;
    await proxyRequest("/proxy/llama3%3Alatest/v1/chat/completions?stream=true", {
      body: { model: "llama3:latest", messages: [] },
    });
    expect(lastUpstreamRequest!.path).toBe("/v1/chat/completions?stream=true");
  });
});

describe("proxy pass-through", () => {
  test("forwards backend response status and body", async () => {
    const res = await proxyRequest("/proxy/llama3%3Alatest/v1/chat/completions", {
      body: { model: "llama3:latest", messages: [] },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { id: string };
    expect(json.id).toBe("chatcmpl-1");
  });

  test("forwards backend 404 as-is", async () => {
    const res = await proxyRequest("/proxy/llama3%3Alatest/v1/nonexistent", {
      body: {},
    });
    expect(res.status).toBe(404);
  });

  test("returns 502 when backend is unreachable", async () => {
    const res = await proxyRequest("/proxy/dead-backend/v1/chat/completions", {
      body: {},
    });
    expect(res.status).toBe(502);
  });
});
