import { describe, test, expect, mock, jest, beforeEach } from "bun:test";
import { MOCK_GATEWAY_ENV } from "./llm-forward/mock-env";
mock.module("./env", () => ({ env: { ...MOCK_GATEWAY_ENV } }));

const insertMock = jest.fn();
const dbMock = {
  insert: () => ({
    values: insertMock,
  }),
};

mock.module("./db", () => ({
  getDB: () => dbMock,
}));

const { logChatSync, logChatStream, flushApiCallRows } = await import("./callLogger");

function sampleChatInput() {
  return {
    keyId: "key-1",
    organizationId: "org-1",
    applicationId: "app-1",
    durationInMS: 100,
    publicSpecifier: "my-model",
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
  });

  test("buffers calls and flushes in batch on flushApiCallRows", async () => {
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

    await flushApiCallRows();

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
    await flushApiCallRows();

    const [batch] = insertMock.mock.calls[0] as [any[]];
    expect(batch.map((row) => row.outputMessage.content)).toEqual(["first", "second"]);
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

    await flushApiCallRows();

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

    await flushApiCallRows();

    // 1 batch + 3 individual
    expect(insertMock).toHaveBeenCalledTimes(4);
  });
});
