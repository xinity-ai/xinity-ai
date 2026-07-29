import { describe, test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createCompactionStep } from "./compaction";

const CONTEXT_LIMIT = 1000;
const THRESHOLD_RATIO = 0.5;
const SUMMARY = "Compacted summary of the research so far.";
const CONTINUE = "Continue your research. You have already covered the above. Focus on remaining gaps.";

const SUMMARY_RESULT = {
  content: [{ type: "text" as const, text: SUMMARY }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 600, noCache: 600, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 20, text: 20, reasoning: undefined },
    totalTokens: 620,
  },
  warnings: [],
};

function makeProvider(shouldFail: () => boolean = () => false) {
  const prompts: ModelMessage[][] = [];
  const provider = {
    chatModel: () => new MockLanguageModelV3({
      doGenerate: async ({ prompt }) => {
        prompts.push(prompt as unknown as ModelMessage[]);
        if (shouldFail()) {
          throw new Error("compaction model unavailable");
        }
        return SUMMARY_RESULT;
      },
    }),
  };
  return { provider: provider as never, prompts };
}

function newStep(provider: never, onUsage?: Parameters<typeof createCompactionStep>[5]) {
  return createCompactionStep(provider, "m", CONTEXT_LIMIT, THRESHOLD_RATIO, "original query", onUsage);
}

async function run(
  step: ReturnType<typeof createCompactionStep>,
  inputTokens: number,
  messages: ModelMessage[],
  outputTokens = 0,
) {
  return await step({ steps: [{ usage: { inputTokens, outputTokens } }], messages }) as { messages?: ModelMessage[] };
}

function contentsOf(messages: ModelMessage[] | undefined): unknown[] {
  return (messages ?? []).map((m) => m.content);
}

const initialHistory = (): ModelMessage[] => [
  { role: "user", content: "original query" },
  { role: "assistant", content: "step 0 findings" },
];

describe("createCompactionStep", () => {
  test("leaves messages untouched below the threshold", async () => {
    const { provider, prompts } = makeProvider();

    const result = await run(newStep(provider), 100, initialHistory());

    expect(result).toEqual({});
    expect(prompts).toHaveLength(0);
  });

  test("counts the last step's output toward the threshold", async () => {
    const { provider, prompts } = makeProvider();

    // The output becomes part of the next prompt, so 400 + 150 crosses a threshold of 500
    // that the input alone would not.
    const result = await run(newStep(provider), 400, initialHistory(), 150);

    expect(contentsOf(result.messages)).toEqual(["original query", SUMMARY, CONTINUE]);
    expect(prompts).toHaveLength(1);
  });

  test("skips the very first step even above the threshold", async () => {
    const { provider, prompts } = makeProvider();

    const result = await newStep(provider)({ steps: [], messages: initialHistory() });

    expect(result).toEqual({});
    expect(prompts).toHaveLength(0);
  });

  test("replaces history with the summary once the threshold is crossed", async () => {
    const { provider, prompts } = makeProvider();

    const result = await run(newStep(provider), 600, initialHistory());

    expect(contentsOf(result.messages)).toEqual(["original query", SUMMARY, CONTINUE]);
    expect(prompts).toHaveLength(1);
  });

  test("replays the summary on later steps instead of falling back to full history", async () => {
    const { provider, prompts } = makeProvider();
    const step = newStep(provider);
    const history = initialHistory();

    await run(step, 600, history);

    // The compacted step reports a small reading, so the trigger stays quiet. The SDK still
    // hands back its own full accumulated history, which must not reach the model again.
    history.push({ role: "assistant", content: "step 1 findings" });
    const next = await run(step, 120, history);

    expect(contentsOf(next.messages)).toEqual(["original query", SUMMARY, CONTINUE, "step 1 findings"]);
    expect(prompts).toHaveLength(1);
  });

  test("summarizes the compacted view, not the original history, on a second compaction", async () => {
    const { provider, prompts } = makeProvider();
    const step = newStep(provider);
    const history = initialHistory();

    await run(step, 600, history);
    history.push({ role: "assistant", content: "step 1 findings" });
    await run(step, 700, history);

    expect(prompts).toHaveLength(2);
    const secondPrompt = JSON.stringify(prompts[1]);
    expect(secondPrompt).toContain(SUMMARY);
    expect(secondPrompt).toContain("step 1 findings");
    expect(secondPrompt).not.toContain("step 0 findings");
  });

  test("keeps the last good summary when a later compaction fails", async () => {
    let shouldFail = false;
    const { provider } = makeProvider(() => shouldFail);
    const step = newStep(provider);
    const history = initialHistory();

    await run(step, 600, history);

    shouldFail = true;
    history.push({ role: "assistant", content: "step 1 findings" });
    const result = await run(step, 700, history);

    expect(contentsOf(result.messages)).toEqual(["original query", SUMMARY, CONTINUE, "step 1 findings"]);
  });

  test("returns no override when the very first compaction fails", async () => {
    const { provider } = makeProvider(() => true);

    const result = await run(newStep(provider), 600, initialHistory());

    expect(result).toEqual({});
  });

  test("reports compaction usage to the callback", async () => {
    const { provider } = makeProvider();
    const seen: Array<{ inputTokens: number; outputTokens: number }> = [];

    await run(newStep(provider, (usage) => { seen.push(usage); }), 600, initialHistory());

    expect(seen).toEqual([{ inputTokens: 600, outputTokens: 20 }]);
  });
});
