import { describe, test, expect, mock, beforeEach } from "bun:test";

let dbShouldFail = false;
const mockUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => {
      if (dbShouldFail) {
        return Promise.reject(new Error("DB connection lost"));
      }
      return Promise.resolve();
    }),
  })),
}));

mock.module("./env", () => ({
  env: { TETHER_SECRET: "test", METRICS_AUTH: undefined },
}));

mock.module("./db", () => ({
  getDB: () => ({ update: mockUpdate }),
}));

mock.module("./logger", () => ({
  rootLogger: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}));

mock.module("./metrics", () => ({
  incSSEConnections: () => {},
  incDesiredStatePushes: () => {},
  observeConnectionDuration: () => {},
  setConnectedNodes: () => {},
  incRequestRejections: () => {},
  handleMetrics: () => new Response(""),
}));

const {
  addConnection,
  removeConnection,
  pushDesiredState,
  isConnected,
  getConnectedNodeIds,
  sendShutdownToAll,
  runKeepaliveLoop,
} = await import("./connections");

function makeController(): { controller: ReadableStreamDefaultController; chunks: Uint8Array[]; stream: ReadableStream } {
  const chunks: Uint8Array[] = [];
  let ctrl!: ReadableStreamDefaultController;
  const stream = new ReadableStream({
    start(c) {
      ctrl = c;
    },
  });
  const original = ctrl;
  const proxy = {
    enqueue: (chunk: Uint8Array) => {
      chunks.push(chunk);
      try { original.enqueue(chunk); } catch {}
    },
    close: () => {
      try { original.close(); } catch {}
    },
  } as unknown as ReadableStreamDefaultController;
  return { controller: proxy, chunks, stream };
}

function makeBrokenController(): ReadableStreamDefaultController {
  return {
    enqueue: () => { throw new Error("stream closed"); },
    close: () => {},
  } as unknown as ReadableStreamDefaultController;
}

function decodeChunks(chunks: Uint8Array[]): string {
  return chunks.map(c => new TextDecoder().decode(c)).join("");
}

describe("connections", () => {
  beforeEach(() => {
    sendShutdownToAll();
    dbShouldFail = false;
  });

  test("addConnection makes node connected", async () => {
    const { controller } = makeController();
    await addConnection("node-1", controller);
    expect(isConnected("node-1")).toBe(true);
    expect(getConnectedNodeIds()).toContain("node-1");
  });

  test("removeConnection makes node disconnected", async () => {
    const { controller } = makeController();
    await addConnection("node-1", controller);
    await removeConnection("node-1", "cancel");
    expect(isConnected("node-1")).toBe(false);
  });

  test("removeConnection is idempotent for unknown nodeId", async () => {
    await removeConnection("nonexistent", "cancel");
    expect(isConnected("nonexistent")).toBe(false);
  });

  test("addConnection supersedes existing connection", async () => {
    const first = makeController();
    const second = makeController();

    await addConnection("node-1", first.controller);
    await addConnection("node-1", second.controller);

    expect(isConnected("node-1")).toBe(true);

    const firstOutput = decodeChunks(first.chunks);
    expect(firstOutput).toContain("event: superseded");
  });

  test("removeConnection with stale connId does not affect the new connection", async () => {
    const first = makeController();
    const second = makeController();

    const firstConnId = await addConnection("node-1", first.controller);
    await addConnection("node-1", second.controller);

    await removeConnection("node-1", "cancel", firstConnId);

    expect(isConnected("node-1")).toBe(true);
    expect(decodeChunks(second.chunks)).not.toContain("event: superseded");
  });

  test("pushDesiredState sends SSE event", async () => {
    const { controller, chunks } = makeController();
    await addConnection("node-1", controller);

    const state = { nodeId: "node-1", installations: [] };
    const ok = pushDesiredState("node-1", state);

    expect(ok).toBe(true);
    const output = decodeChunks(chunks);
    expect(output).toContain("event: state");
    expect(output).toContain('"nodeId":"node-1"');
  });

  test("pushDesiredState returns false for unknown node", () => {
    const ok = pushDesiredState("unknown", { nodeId: "unknown", installations: [] });
    expect(ok).toBe(false);
  });

  test("pushDesiredState removes connection on write failure", async () => {
    await addConnection("node-broken", makeBrokenController());
    expect(isConnected("node-broken")).toBe(true);

    const ok = pushDesiredState("node-broken", { nodeId: "node-broken", installations: [] });
    expect(ok).toBe(false);

    await Bun.sleep(10);
    expect(isConnected("node-broken")).toBe(false);
  });

  test("sendShutdownToAll sends shutdown event and clears all", async () => {
    const a = makeController();
    const b = makeController();

    await addConnection("node-a", a.controller);
    await addConnection("node-b", b.controller);

    sendShutdownToAll();

    expect(getConnectedNodeIds()).toHaveLength(0);
    expect(decodeChunks(a.chunks)).toContain("event: shutdown");
    expect(decodeChunks(b.chunks)).toContain("event: shutdown");
  });

  test("multiple distinct nodes tracked independently", async () => {
    const a = makeController();
    const b = makeController();

    await addConnection("node-a", a.controller);
    await addConnection("node-b", b.controller);

    expect(getConnectedNodeIds()).toHaveLength(2);
    expect(isConnected("node-a")).toBe(true);
    expect(isConnected("node-b")).toBe(true);

    await removeConnection("node-a", "cancel");
    expect(isConnected("node-a")).toBe(false);
    expect(isConnected("node-b")).toBe(true);
  });

  test("addConnection succeeds even when DB write fails", async () => {
    dbShouldFail = true;
    const { controller } = makeController();
    await addConnection("node-dbfail", controller);
    expect(isConnected("node-dbfail")).toBe(true);
  });

  test("removeConnection succeeds even when DB write fails", async () => {
    const { controller } = makeController();
    await addConnection("node-dbfail2", controller);
    dbShouldFail = true;
    await removeConnection("node-dbfail2", "cancel");
    expect(isConnected("node-dbfail2")).toBe(false);
  });
});

describe("keepalive loop", () => {
  beforeEach(() => {
    sendShutdownToAll();
    dbShouldFail = false;
  });

  test("sends keepalive comment to connected nodes", async () => {
    const { controller, chunks } = makeController();
    await addConnection("node-ka", controller);

    const timer = runKeepaliveLoop(50, 10_000);
    await Bun.sleep(80);
    clearInterval(timer);

    const output = decodeChunks(chunks);
    expect(output).toContain(": keepalive");
  });

  test("removes node after liveness timeout", async () => {
    await addConnection("node-timeout", makeBrokenController());
    expect(isConnected("node-timeout")).toBe(true);

    const timer = runKeepaliveLoop(50, 10);
    await Bun.sleep(80);
    clearInterval(timer);

    expect(isConnected("node-timeout")).toBe(false);
  });
});
