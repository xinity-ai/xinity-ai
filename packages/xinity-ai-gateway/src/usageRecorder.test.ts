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

const { recordUsageEvent, flushUsageEvents } = await import("./usageRecorder");

function sampleRecord(index: number) {
  return {
    organizationId: "org-1",
    applicationId: "app-1",
    apiKeyId: "key-1",
    model: `model-${index}`,
    inputTokens: 10 + index,
    outputTokens: 20 + index,
    duration: 100 + index,
    logged: true,
    nodeId: `node-${index}`,
    success: true,
  };
}

describe("usageRecorder", () => {
  beforeEach(() => {
    insertMock.mockReset();
  });

  test("buffers records and flushes in a batch on flushUsageEvents", async () => {
    insertMock.mockResolvedValue(undefined);

    recordUsageEvent(sampleRecord(1));
    recordUsageEvent(sampleRecord(2));

    // Not flushed yet
    expect(insertMock).not.toHaveBeenCalled();

    await flushUsageEvents();

    expect(insertMock).toHaveBeenCalledTimes(1);
    const [batch] = insertMock.mock.calls[0] as [any[]];
    expect(batch.length).toBe(2);
    expect(batch[0].model).toBe("model-1");
    expect(batch[1].model).toBe("model-2");
  });

  test("auto-flushes when batch size reaches 50", async () => {
    insertMock.mockResolvedValue(undefined);

    for (let i = 0; i < 49; i++) {
      recordUsageEvent(sampleRecord(i));
    }
    expect(insertMock).not.toHaveBeenCalled();

    recordUsageEvent(sampleRecord(49)); // 50th record triggers flush
    // Give async void flush microtask a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(insertMock).toHaveBeenCalledTimes(1);
    const [batch] = insertMock.mock.calls[0] as [any[]];
    expect(batch.length).toBe(50);
  });

  test("auto-flushes on timer interval", async () => {
    insertMock.mockResolvedValue(undefined);

    recordUsageEvent(sampleRecord(1));
    expect(insertMock).not.toHaveBeenCalled();

    // Wait for 200ms timer
    await new Promise((r) => setTimeout(r, 250));

    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  test("falls back to individual row inserts when batch insert fails", async () => {
    insertMock
      .mockRejectedValueOnce(new Error("Batch insert failed: unique constraint or bad value"))
      .mockResolvedValueOnce(undefined) // first row succeeds
      .mockRejectedValueOnce(new Error("Bad row error")) // second row fails
      .mockResolvedValueOnce(undefined); // third row succeeds

    recordUsageEvent(sampleRecord(1));
    recordUsageEvent(sampleRecord(2));
    recordUsageEvent(sampleRecord(3));

    await flushUsageEvents();

    // 1 batch attempt + 3 individual attempts
    expect(insertMock).toHaveBeenCalledTimes(4);
  });
});
