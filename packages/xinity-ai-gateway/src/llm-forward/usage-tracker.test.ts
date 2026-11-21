import { describe, test, expect } from "bun:test";
import { createUsageTracker, observeParsedChunk } from "./usage-tracker";

function usage(prompt: number, completion: number) {
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

describe("usage tracker", () => {
  test("returns undefined when no usage was seen", () => {
    const tracker = createUsageTracker();
    tracker.startCall();
    expect(tracker.total()).toBeUndefined();
  });

  test("one choice: prompt plus the completion of the last chunk", () => {
    const tracker = createUsageTracker();
    tracker.observeChunk(usage(10, 1), 0);
    tracker.observeChunk(usage(10, 2), 0);
    tracker.observeChunk(usage(10, 3), 0);
    expect(tracker.total()).toEqual({ inputTokens: 10, outputTokens: 3 });
  });

  test("n = 2: per-choice completions add up and the prompt counts once", () => {
    const tracker = createUsageTracker();
    tracker.observeChunk(usage(10, 1), 0);
    tracker.observeChunk(usage(10, 1), 1);
    tracker.observeChunk(usage(10, 2), 0);
    tracker.observeChunk(usage(10, 4), 1);
    expect(tracker.total()).toEqual({ inputTokens: 10, outputTokens: 6 });
  });

  test("a final usage replaces the per-choice values and later chunks are ignored", () => {
    const tracker = createUsageTracker();
    tracker.observeChunk(usage(10, 2), 0);
    tracker.observeFinal(usage(12, 7));
    tracker.observeChunk(usage(10, 50), 0);
    expect(tracker.total()).toEqual({ inputTokens: 12, outputTokens: 7 });
  });

  test("two backend calls add up", () => {
    const tracker = createUsageTracker();
    tracker.startCall();
    tracker.observeChunk(usage(10, 3), 0);
    tracker.observeFinal(usage(10, 4));
    tracker.startCall();
    tracker.observeChunk(usage(20, 2), 0);
    expect(tracker.total()).toEqual({ inputTokens: 30, outputTokens: 6 });
  });

  test("a smaller later value does not lower the count", () => {
    const tracker = createUsageTracker();
    tracker.observeChunk(usage(10, 5), 0);
    tracker.observeChunk(usage(8, 3), 0);
    expect(tracker.total()).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

describe("observeParsedChunk", () => {
  test("ignores a chunk with usage: null", () => {
    const tracker = createUsageTracker();
    observeParsedChunk(tracker, { choices: [{ index: 0 }], usage: null });
    expect(tracker.total()).toBeUndefined();
  });

  test("treats a chunk without choices as the final usage", () => {
    const tracker = createUsageTracker();
    observeParsedChunk(tracker, { choices: [{ index: 0 }], usage: usage(10, 2) });
    observeParsedChunk(tracker, { choices: [], usage: usage(10, 9) });
    observeParsedChunk(tracker, { choices: [{ index: 0 }], usage: usage(10, 40) });
    expect(tracker.total()).toEqual({ inputTokens: 10, outputTokens: 9 });
  });

  test("uses the index of the first choice", () => {
    const tracker = createUsageTracker();
    observeParsedChunk(tracker, { choices: [{ index: 0 }], usage: usage(10, 2) });
    observeParsedChunk(tracker, { choices: [{ index: 1 }], usage: usage(10, 3) });
    expect(tracker.total()).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  test("ignores a value that is not an object", () => {
    const tracker = createUsageTracker();
    observeParsedChunk(tracker, "not a chunk");
    observeParsedChunk(tracker, null);
    observeParsedChunk(tracker, 42);
    expect(tracker.total()).toBeUndefined();
  });
});
