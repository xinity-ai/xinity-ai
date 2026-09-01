import { describe, test, expect, mock, beforeEach } from "bun:test";
import { chatMessageT, inferenceCallT } from "common-db";
import { MOCK_GATEWAY_ENV } from "./llm-forward/mock-env";
mock.module("./env", () => ({ env: { ...MOCK_GATEWAY_ENV } }));

/** Rows each table was given, keyed by table. */
const inserted = new Map<string, any[]>();
let failWrite = false;

function tableName(table: unknown): string {
  if (table === chatMessageT) return "chat_message";
  if (table === inferenceCallT) return "inference_call";
  return "inference_call_message";
}

const dbMock = {
  insert: (table: unknown) => ({
    values: (rows: unknown) => {
      const name = tableName(table);
      const list = (Array.isArray(rows) ? rows : [rows]) as any[];
      inserted.set(name, [...(inserted.get(name) ?? []), ...list]);
      const done = Promise.resolve(undefined) as Promise<undefined> & Record<string, unknown>;
      done.onConflictDoNothing = () => ({
        returning: async () => list.map((row) => ({ id: `id-${row.sha256}`, sha256: row.sha256 })),
      });
      return done;
    },
  }),
  select: () => ({ from: () => ({ where: async () => [] }) }),
  transaction: async (run: (tx: unknown) => unknown) => {
    if (failWrite) {
      throw new Error("log write down");
    }
    return run(dbMock);
  },
};

mock.module("./db", () => ({ getDB: () => dbMock }));

const { logChatSync, logChatStream, flushCallLog } = await import("./callLogger");

const calls = () => inserted.get("inference_call") ?? [];
const messagePayloads = () => (inserted.get("chat_message") ?? []).map((row) => row.body);

/** Distinct per test, since the digest cache is module-level and would skip a repeat insert. */
let orgCounter = 0;
function freshOrg(): string {
  orgCounter += 1;
  return `calllog-org-${orgCounter}`;
}

function sampleChatInput() {
  return {
    keyId: "key-1",
    organizationId: freshOrg(),
    applicationId: "app-1",
    durationInMS: 100,
    publicSpecifier: "my-model",
    servedModel: "engine-model",
    endpoint: "chat_completions" as const,
    inputMessages: [{ role: "user" as const, content: "Hello world" }],
    metadata: { env: "test" },
    data: {
      model: "llama3:latest",
      choices: [{ index: 0, message: { role: "assistant", content: "Response" } }],
    },
  };
}

beforeEach(() => {
  inserted.clear();
  failWrite = false;
});

describe("callLogger", () => {
  test("buffers calls and writes the batch as one insert", async () => {
    await logChatSync(sampleChatInput());
    await logChatSync(sampleChatInput());

    expect(calls()).toHaveLength(0);

    await flushCallLog();

    expect(calls()).toHaveLength(2);
    expect(calls()[0].endpoint).toBe("chat_completions");
  });

  test("gives each streamed choice its own call", async () => {
    const { data: _sync, ...fields } = sampleChatInput();

    await logChatStream({
      ...fields,
      data: [
        { model: "llama3:latest", choices: [{ index: 0, delta: { role: "assistant", content: "first" }, finish_reason: "stop" }] },
        { model: "llama3:latest", choices: [{ index: 1, delta: { role: "assistant", content: "second" }, finish_reason: "stop" }] },
      ],
    });
    await flushCallLog();

    expect(calls()).toHaveLength(2);
    const replies = messagePayloads().map((m) => m.content);
    expect(replies).toContain("first");
    expect(replies).toContain("second");
  });

  test("records the engine's own model name, which the legacy log never did", async () => {
    await logChatSync(sampleChatInput());
    await flushCallLog();

    expect(calls()[0].servedModel).toBe("engine-model");
    expect(calls()[0].publicSpecifier).toBe("my-model");
  });

  test("keeps reasoning and refusal the engine sent", async () => {
    const input = sampleChatInput();

    await logChatSync({
      ...input,
      data: {
        model: "llama3:latest",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "Answer", reasoning_content: "Thought", refusal: null },
        }],
      },
    });
    await flushCallLog();

    const reply = messagePayloads().find((m) => m.content === "Answer");
    expect(reply.reasoning_content).toBe("Thought");
    expect(reply).toHaveProperty("refusal");
  });

  test("stores reasoning under one name whichever the engine used", async () => {
    const input = sampleChatInput();

    await logChatSync({
      ...input,
      data: {
        model: "llama3:latest",
        choices: [{ index: 0, message: { role: "assistant", content: "Answer", reasoning: "Thought" } }],
      },
    });
    await flushCallLog();

    const reply = messagePayloads().find((m) => m.content === "Answer");
    expect(reply.reasoning_content).toBe("Thought");
    expect(reply).not.toHaveProperty("reasoning");
  });

  test("adds no reasoning key to a reply that carried none", async () => {
    await logChatSync(sampleChatInput());
    await flushCallLog();

    const reply = messagePayloads().find((m) => m.content === "Response");
    expect(reply).not.toHaveProperty("reasoning_content");
  });

  test("uses an id the caller reserved before the batch was flushed", async () => {
    const reserved = "88888888-8888-4888-8888-888888888888";

    await logChatSync({ ...sampleChatInput(), inferenceCallId: reserved });
    await flushCallLog();

    expect(calls()[0].id).toBe(reserved);
  });

  test("auto-flushes on timer interval", async () => {
    await logChatSync(sampleChatInput());

    expect(calls()).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 250));

    expect(calls()).toHaveLength(1);
  });

  test("strips null bytes, which postgres rejects outright", async () => {
    await logChatSync({
      ...sampleChatInput(),
      inputMessages: [{ role: "user" as const, content: "Hello\0world" }],
      data: {
        model: "llama3:latest",
        choices: [{ index: 0, message: { role: "assistant", content: "Result\0null" } }],
      },
    });
    await flushCallLog();

    const contents = messagePayloads().map((m) => m.content);
    expect(contents).toContain("Helloworld");
    expect(contents).toContain("Resultnull");
  });

  test("swallows a failed write rather than breaking the request that logged it", async () => {
    failWrite = true;

    await logChatSync(sampleChatInput());

    expect(flushCallLog()).resolves.toBeUndefined();
  });
});
