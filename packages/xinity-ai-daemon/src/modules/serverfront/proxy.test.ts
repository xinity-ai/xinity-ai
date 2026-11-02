import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import type { Server, TCPSocketListener } from "bun";
import { mockDaemonConfig } from "../../mock-config";
import { signRequest } from "common-env";
import type { ProxySocketData } from "./proxy";

let mockPort: number = 0;

mock.module("../../config", () => ({ config: mockDaemonConfig({ STATE_DIR: "/tmp/test" }) }));

const { getAuthToken } = await import("../statekeeper");
const { updateRegistry } = await import("../model-registry");
const { handleProxyRequest, handleProxyUpgrade, createProxySocketHandler, connectingRelayStats } = await import("./proxy");

let server: ReturnType<typeof Bun.serve>;
let lastUpstreamRequest: { method: string; path: string; body: unknown } | null = null;
let endlessStreamCancelled = false;
let upstreamSocketClosed = false;
let stalledBackend: TCPSocketListener<undefined>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    websocket: {
      message(ws, message) {
        if (message === "close-me") {
          ws.close(4001, "asked to");
        } else {
          ws.send(message);
        }
      },
      close() {
        upstreamSocketClosed = true;
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/realtime" && srv.upgrade(req, { data: undefined })) {
        return undefined;
      }
      const body = req.method !== "GET" ? await req.json().catch(() => null) : null;
      lastUpstreamRequest = { method: req.method, path: url.pathname + url.search, body };

      if (url.pathname === "/v1/endless") {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          },
          cancel() {
            endlessStreamCancelled = true;
          },
        }));
      }
      if (url.pathname === "/v1/chat/completions") {
        return Response.json({ id: "chatcmpl-1", choices: [], model: "llama3:latest" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  if (server.port == null) throw new Error("Bun.serve did not allocate a TCP port");
  mockPort = server.port;

  // Accepts the connection and never answers, like an engine stuck before its handshake.
  stalledBackend = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });

  updateRegistry([
    { id: "inst-ollama", specifier: "llama3:latest", port: mockPort, driver: "ollama" },
    { id: "inst-vllm", specifier: "meta-llama/Llama-3.1-8B", port: mockPort, driver: "vllm" },
    { id: "inst-vllm-other-deployment", specifier: "meta-llama/Llama-3.1-8B", port: 1, driver: "vllm" },
    { id: "inst-dead", specifier: "dead-backend", port: 1, driver: "vllm" },
    { id: "inst-stalled", specifier: "stalled-backend", port: stalledBackend.port, driver: "vllm" },
  ]);
});

afterAll(() => {
  server.stop(true);
  stalledBackend.stop(true);
});

function proxyRequest(
  path: string,
  options?: { method?: string; body?: unknown; token?: string | null; signedPath?: string; signal?: AbortSignal },
) {
  const method = options?.method ?? "POST";
  const token = options?.token === undefined ? getAuthToken() : options.token;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const url = new URL(path, "http://localhost");
  if (token !== null) {
    headers.authorization = signRequest(token, {
      method,
      path: options?.signedPath ?? `${url.pathname}${url.search}`,
    });
  }
  const req = new Request(url.toString(), {
    method,
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
    signal: options?.signal,
  });
  return handleProxyRequest(req, url);
}

describe("proxy auth", () => {
  test("rejects a missing signature", async () => {
    const res = await proxyRequest("/proxy/inst-ollama/v1/chat/completions", { token: null });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("No Authorization header");
  });

  test("rejects a signature made with the wrong token", async () => {
    const res = await proxyRequest("/proxy/inst-ollama/v1/chat/completions", { token: "wrong" });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("does not match this node's auth token");
  });

  test("rejects the raw token as a bearer header", async () => {
    const url = new URL("/proxy/inst-ollama/v1/chat/completions", "http://localhost");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { authorization: `Bearer ${getAuthToken()}` },
    });
    const res = await handleProxyRequest(req, url);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("not a Xinity signature");
  });

  // Every model on the node shares one token, so the path is what keeps a captured header from
  // being pointed at a different model.
  test("rejects a signature made for another installation's path", async () => {
    const res = await proxyRequest("/proxy/inst-ollama/v1/chat/completions", {
      signedPath: "/proxy/inst-vllm/v1/chat/completions",
      body: { model: "llama3:latest", messages: [] },
    });
    expect(res.status).toBe(401);
  });

  test("rejects a signature that omits the query string", async () => {
    const res = await proxyRequest("/proxy/inst-ollama/v1/chat/completions?stream=true", {
      signedPath: "/proxy/inst-ollama/v1/chat/completions",
      body: { model: "llama3:latest", messages: [] },
    });
    expect(res.status).toBe(401);
  });

  test("accepts a request signed with the node token", async () => {
    const res = await proxyRequest("/proxy/inst-ollama/v1/chat/completions", {
      body: { model: "llama3:latest", messages: [] },
    });
    expect(res.status).toBe(200);
  });
});

describe("proxy routing", () => {
  test("rejects a signed request sent a second time", async () => {
    const path = "/proxy/inst-ollama/v1/chat/completions";
    const url = new URL(`http://daemon${path}`);
    const header = signRequest(getAuthToken(), { method: "POST", path });
    const send = () => handleProxyRequest(new Request(url.toString(), { method: "POST", headers: { authorization: header } }), url);

    expect((await send()).status).not.toBe(401);
    const replay = await send();
    expect(replay.status).toBe(401);
    expect(await replay.text()).toContain("already used");
  });

  test("returns 400 for invalid proxy path", async () => {
    const res = await proxyRequest("/proxy/");
    expect(res.status).toBe(400);
  });

  test("returns 404 for an unknown installation", async () => {
    const res = await proxyRequest("/proxy/nonexistent/v1/chat/completions");
    expect(res.status).toBe(404);
  });

  test("routes two installations of one model on the node to their own backends", async () => {
    const own = await proxyRequest("/proxy/inst-vllm/v1/chat/completions", {
      body: { model: "meta-llama/Llama-3.1-8B", messages: [] },
    });
    const other = await proxyRequest("/proxy/inst-vllm-other-deployment/v1/chat/completions", {
      body: { model: "meta-llama/Llama-3.1-8B", messages: [] },
    });
    expect(own.status).toBe(200);
    expect(other.status).toBe(502);
  });

  test("forwards query string to backend", async () => {
    lastUpstreamRequest = null;
    await proxyRequest("/proxy/inst-ollama/v1/chat/completions?stream=true", {
      body: { model: "llama3:latest", messages: [] },
    });
    expect(lastUpstreamRequest!.path).toBe("/v1/chat/completions?stream=true");
  });
});

describe("proxy pass-through", () => {
  test("forwards backend response status and body", async () => {
    const res = await proxyRequest("/proxy/inst-ollama/v1/chat/completions", {
      body: { model: "llama3:latest", messages: [] },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { id: string };
    expect(json.id).toBe("chatcmpl-1");
  });

  test("forwards backend 404 as-is", async () => {
    const res = await proxyRequest("/proxy/inst-ollama/v1/nonexistent", {
      body: {},
    });
    expect(res.status).toBe(404);
  });

  test("returns 502 when backend is unreachable", async () => {
    const res = await proxyRequest("/proxy/inst-dead/v1/chat/completions", {
      body: {},
    });
    expect(res.status).toBe(502);
  });
});

describe("proxy cancellation", () => {
  test("cancels the backend request when the caller gives up", async () => {
    const caller = new AbortController();
    const res = await proxyRequest("/proxy/inst-vllm/v1/endless", { method: "GET", signal: caller.signal });
    const reader = res.body!.getReader();
    await reader.read();

    caller.abort();
    await reader.read().catch(() => {});
    await Bun.sleep(50);
    expect(endlessStreamCancelled).toBe(true);
  });
});

describe("proxy WebSocket", () => {
  const CONNECT_TIMEOUT_MS = 300;
  let daemon: Server<ProxySocketData>;

  beforeAll(() => {
    daemon = Bun.serve({
      port: 0,
      websocket: createProxySocketHandler(CONNECT_TIMEOUT_MS),
      fetch: (req, srv) => handleProxyUpgrade(req, new URL(req.url), srv),
    });
  });

  afterAll(() => {
    daemon.stop(true);
  });

  function connect(path: string) {
    const authorization = signRequest(getAuthToken(), { method: "GET", path });
    const socket = new WebSocket(`ws://localhost:${daemon.port}${path}`, { headers: { authorization } });
    const received: string[] = [];
    socket.addEventListener("message", (event) => received.push(String(event.data)));
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
    return { socket, received, closed };
  }

  test("refuses an unsigned upgrade before handing over the connection", async () => {
    const res = await fetch(`http://localhost:${daemon.port}/proxy/inst-vllm/v1/realtime`, {
      headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    expect(res.status).toBe(401);
  });

  test("relays frames both ways, including ones sent before the backend connected", async () => {
    const { socket, received } = connect("/proxy/inst-vllm/v1/realtime");
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    socket.send("first");
    socket.send("second");
    await Bun.sleep(100);
    expect(received).toEqual(["first", "second"]);
    socket.close();
  });

  test("passes the backend's close code on to the caller", async () => {
    const { socket, closed } = connect("/proxy/inst-vllm/v1/realtime");
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    socket.send("close-me");
    expect((await closed).code).toBe(4001);
  });

  test("closes the backend socket when the caller leaves", async () => {
    upstreamSocketClosed = false;
    const { socket } = connect("/proxy/inst-vllm/v1/realtime");
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    socket.send("hello");
    await Bun.sleep(50);
    socket.close();
    await Bun.sleep(100);
    expect(upstreamSocketClosed).toBe(true);
  });

  test("closes the caller with an error when the backend cannot be reached", async () => {
    const { closed } = connect("/proxy/inst-dead/v1/realtime");
    expect((await closed).code).toBe(1011);
  });

  test("reports frames held for a backend stuck before its handshake, and forgets them once the caller leaves", async () => {
    const { socket, closed } = connect("/proxy/inst-stalled/v1/realtime");
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    socket.send("12345");
    socket.send("678");
    await Bun.sleep(50);
    expect(connectingRelayStats()).toMatchObject({ connections: 1, queuedBytes: 8 });

    socket.close();
    await closed;
    await Bun.sleep(50);
    expect(connectingRelayStats()).toMatchObject({ connections: 0, queuedBytes: 0 });
  });

  test("gives up on a backend that never completes its handshake", async () => {
    const { closed } = connect("/proxy/inst-stalled/v1/realtime");
    expect((await closed).code).toBe(1011);
    expect(connectingRelayStats().connections).toBe(0);
  });
});
