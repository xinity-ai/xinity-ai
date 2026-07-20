import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

const mockUpdate = mock(() => ({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) }));

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
  incLivenessTimeouts: () => {},
  setConnectedNodes: () => {},
  incRegistrationWrites: () => {},
  incStateWrites: () => {},
  handleMetrics: () => new Response(""),
}));

const {
  addConnection,
  removeConnection,
  pushDesiredState,
  isConnected,
  getConnectedNodeIds,
  sendShutdownToAll,
} = await import("./connections");

function makeController(): { controller: ReadableStreamDefaultController; chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  let ctrl!: ReadableStreamDefaultController;
  new ReadableStream({
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
  return { controller: proxy, chunks };
}

function decodeChunks(chunks: Uint8Array[]): string {
  return chunks.map(c => new TextDecoder().decode(c)).join("");
}

describe("connections", () => {
  beforeEach(async () => {
    sendShutdownToAll();
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
    await removeConnection("node-1");
    expect(isConnected("node-1")).toBe(false);
  });

  test("removeConnection is idempotent for unknown nodeId", async () => {
    await removeConnection("nonexistent");
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

    await removeConnection("node-a");
    expect(isConnected("node-a")).toBe(false);
    expect(isConnected("node-b")).toBe(true);
  });
});
