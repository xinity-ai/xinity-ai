import { describe, test, expect, mock, jest, beforeEach } from "bun:test";
import { apiCallT, chatMessageT, inferenceCallT } from "common-db";
import { MOCK_GATEWAY_ENV } from "./llm-forward/mock-env";
mock.module("./env", () => ({ env: { ...MOCK_GATEWAY_ENV } }));

const insertMock = jest.fn();

/** Tables the inference-call path wrote, in order. */
const inferenceWrites: string[] = [];
let failInference = false;

function recordingInsert(table: string) {
  return {
    values: (rows: unknown) => {
      inferenceWrites.push(table);
      const inserted = Array.isArray(rows) ? rows : [rows];
      const done = Promise.resolve(undefined) as Promise<undefined> & Record<string, unknown>;
      done.onConflictDoNothing = () => ({
        returning: async () => inserted.map((row) => ({
          id: `id-${(row as { sha256: string }).sha256}`,
          sha256: (row as { sha256: string }).sha256,
        })),
      });
      return done;
    },
  };
}

const dbMock = {
  insert: (table: unknown) => {
    if (table === apiCallT) return { values: insertMock };
    if (table === chatMessageT) return recordingInsert("chat_message");
    if (table === inferenceCallT) return recordingInsert("inference_call");
    return recordingInsert("inference_call_message");
  },
  select: () => ({ from: () => ({ where: async () => [] }) }),
  transaction: async (run: (tx: unknown) => unknown) => {
    if (failInference) {
      throw new Error("inference write down");
    }
    return run(dbMock);
  },
};

mock.module("./db", () => ({
  getDB: () => dbMock,
}));

const { logChatSync, logChatStream, flushCallLog } = await import("./callLogger");

function sampleChatInput() {
  return {
    keyId: "key-1",
    organizationId: "org-1",
    applicationId: "app-1",
    durationInMS: 100,
    publicSpecifier: "my-model",
    engineModel: "engine-model",
    endpoint: "chat_completions" as const,
    inputMessages: [{ role: "user" as const, content: "Hello world" }],
    metadata: { env: "test" },
    data: {
      model: "llama3:latest",
      choices: [{ index: 0, message: { role: "assistant", content: "Response" } }],
    },
  };
}

describe("callLogger", () => {
  beforeEach(() => {
    insertMock.mockReset();
    inferenceWrites.length = 0;
    failInference = false;
  });

  test("buffers calls and flushes in batch on flushCallLog", async () => {
    insertMock.mockResolvedValue(undefined);

    await logChatSync(sampleChatInput());
    await logChatSync({
      ...sampleChatInput(),
      data: {
        model: "llama3:latest",
        choices: [{ index: 0, message: { role: "assistant", content: "Response 2" } }],
      },
    });

    // Buffered, not flushed yet
    expect(insertMock).not.toHaveBeenCalled();

    await flushCallLog();

    expect(insertMock).toHaveBeenCalledTimes(1);
    const [batch] = insertMock.mock.calls[0] as [any[]];
    expect(batch.length).toBe(2);
    expect(batch[0].organizationId).toBe("org-1");
  });

  test("gives each streamed choice its own row", async () => {
    insertMock.mockResolvedValue(undefined);
    const { data: _sync, ...fields } = sampleChatInput();

    await logChatStream({
      ...fields,
      data: [
        { model: "llama3:latest", choices: [{ index: 0, delta: { role: "assistant", content: "first" }, finish_reason: "stop" }] },
        { model: "llama3:latest", choices: [{ index: 1, delta: { role: "assistant", content: "second" }, finish_reason: "stop" }] },
      ],
    });
    await flushCallLog();

    const [batch] = insertMock.mock.calls[0] as [any[]];
    expect(batch.map((row) => row.outputMessage.content)).toEqual(["first", "second"]);
  });

  test("keeps reasoning and refusal the engine sent", async () => {
    insertMock.mockResolvedValue(undefined);
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

    const [batch] = insertMock.mock.calls[0] as [any[]];
    expect(batch[0].outputMessage.reasoning_content).toBe("Thought");
    expect(batch[0].outputMessage).toHaveProperty("refusal");
  });

  test("stores reasoning under one name whichever the engine used", async () => {
    insertMock.mockResolvedValue(undefined);
    const input = sampleChatInput();

    await logChatSync({
      ...input,
      data: {
        model: "llama3:latest",
        choices: [{ index: 0, message: { role: "assistant", content: "Answer", reasoning: "Thought" } }],
      },
    });
    await flushCallLog();

    const [batch] = insertMock.mock.calls[0] as [any[]];
    expect(batch[0].outputMessage.reasoning_content).toBe("Thought");
    expect(batch[0].outputMessage).not.toHaveProperty("reasoning");
  });

  test("adds no reasoning key to a reply that carried none", async () => {
    insertMock.mockResolvedValue(undefined);

    await logChatSync(sampleChatInput());
    await flushCallLog();

    const [batch] = insertMock.mock.calls[0] as [any[]];
    expect(batch[0].outputMessage).not.toHaveProperty("reasoning_content");
  });

  test("writes the inference call alongside the legacy row", async () => {
    insertMock.mockResolvedValue(undefined);

    await logChatSync({ ...sampleChatInput(), organizationId: "dual-write-org" });
    await flushCallLog();

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(inferenceWrites).toContain("inference_call");
    expect(inferenceWrites).toContain("inference_call_message");
  });

  test("keeps the legacy row when the inference write fails", async () => {
    insertMock.mockResolvedValue(undefined);
    failInference = true;

    await logChatSync({ ...sampleChatInput(), organizationId: "isolated-org" });
    await flushCallLog();

    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  test("auto-flushes on timer interval", async () => {
    insertMock.mockResolvedValue(undefined);

    await logChatSync(sampleChatInput());

    expect(insertMock).not.toHaveBeenCalled();

    // Wait for 200ms timer
    await new Promise((r) => setTimeout(r, 250));

    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  test("sanitizes null bytes when present", async () => {
    insertMock.mockResolvedValue(undefined);

    await logChatSync({
      ...sampleChatInput(),
      inputMessages: [{ role: "user" as const, content: "Hello\0world" }],
      data: {
        model: "llama3:latest",
        choices: [{ index: 0, message: { role: "assistant", content: "Result\0null" } }],
      },
    });

    await flushCallLog();

    expect(insertMock).toHaveBeenCalledTimes(1);
    const [batch] = insertMock.mock.calls[0] as [any[]];
    expect(batch[0].inputMessages[0].content).toBe("Helloworld");
    expect(batch[0].outputMessage.content).toBe("Resultnull");
  });

  test("falls back to individual row inserts when batch fails", async () => {
    insertMock
      .mockRejectedValueOnce(new Error("Batch insert error"))
      .mockResolvedValueOnce(undefined) // row 1 succeeds
      .mockRejectedValueOnce(new Error("Row 2 constraint error")) // row 2 fails
      .mockResolvedValueOnce(undefined); // row 3 succeeds

    await logChatSync(sampleChatInput());
    await logChatSync(sampleChatInput());
    await logChatSync(sampleChatInput());

    await flushCallLog();

    // 1 batch + 3 individual
    expect(insertMock).toHaveBeenCalledTimes(4);
  });
});
