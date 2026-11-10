import { describe, test, expect, spyOn, afterEach, afterAll } from "bun:test";
import * as usageRecorder from "../usageRecorder";
import * as metrics from "../metrics";
import { recordFailedRequest } from "./usage";

const context = {
  auth: { orgId: "org-1", keyId: "key-1", applicationId: "app-1", collectData: true },
  modelInfo: { model: "test-model", nodeId: "node-1" },
  callStartTime: Date.now(),
};

const recordUsageEvent = spyOn(usageRecorder, "recordUsageEvent").mockImplementation(() => {});
const recordTokenUsage = spyOn(metrics, "recordTokenUsage").mockImplementation(() => {});

afterEach(() => {
  recordUsageEvent.mockClear();
  recordTokenUsage.mockClear();
});

afterAll(() => {
  recordUsageEvent.mockRestore();
  recordTokenUsage.mockRestore();
});

describe("recordFailedRequest", () => {
  test("with usage, writes the tokens on a failed row and gives no deployment to the metrics", () => {
    recordFailedRequest(context, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });

    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent.mock.calls[0]![0]).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      success: false,
      logged: false,
    });
    expect(recordTokenUsage).toHaveBeenCalledTimes(1);
    expect(recordTokenUsage.mock.calls[0]).toEqual(["test-model", "key-1", "org-1", { inputTokens: 12, outputTokens: 3 }]);
  });

  test("without usage, writes 0/0", () => {
    recordFailedRequest(context);

    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent.mock.calls[0]![0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      success: false,
      logged: false,
    });
    expect(recordTokenUsage).not.toHaveBeenCalled();
  });
});
