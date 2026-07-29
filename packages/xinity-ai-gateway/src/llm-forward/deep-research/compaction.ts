import { generateText, type ModelMessage } from "ai";
import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { COMPACTION_SYSTEM_PROMPT } from "./prompts";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "deep-research-compaction" });

type StepWithUsage = {
  usage?: { inputTokens?: number; outputTokens?: number };
};

// The last step's own output is appended to the history, so it becomes part of the next
// prompt. Tool result messages land there too and are in neither figure, which leaves this
// a floor rather than an exact size.
function lastStepTokens(steps: ReadonlyArray<StepWithUsage>): number {
  const usage = steps[steps.length - 1]?.usage;
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

export type CompactionUsageCallback = (usage: { inputTokens: number; outputTokens: number }) => void;

export function createCompactionStep(
  provider: OpenAICompatibleProvider,
  modelId: string,
  contextLimit: number,
  compactionThreshold: number,
  originalUserQuery: string,
  onCompactionUsage?: CompactionUsageCallback,
) {
  const threshold = Math.floor(contextLimit * compactionThreshold);

  // A returned `messages` array replaces the history for that one step only, and the SDK
  // keeps accumulating its own, so the summary must be re-supplied on every later step.
  let compacted: ModelMessage[] | undefined;
  let compactedUpTo = 0;

  return async ({ steps, messages }: { steps: ReadonlyArray<StepWithUsage>; messages: ModelMessage[] }) => {
    if (steps.length === 0) return {};

    const effectiveMessages = compacted ? [...compacted, ...messages.slice(compactedUpTo)] : messages;
    const carryForward = () => (compacted ? { messages: effectiveMessages } : {});

    const projectedTokens = lastStepTokens(steps);
    if (projectedTokens < threshold) return carryForward();

    log.info(
      { projectedTokens, threshold, stepCount: steps.length },
      "Context compaction triggered",
    );

    try {
      const summary = await generateText({
        model: provider.chatModel(modelId),
        system: COMPACTION_SYSTEM_PROMPT,
        messages: effectiveMessages,
        maxRetries: 1,
      });

      if (summary.usage && onCompactionUsage) {
        onCompactionUsage({
          inputTokens: summary.usage.inputTokens ?? 0,
          outputTokens: summary.usage.outputTokens ?? 0,
        });
      }

      compacted = [
        { role: "user", content: originalUserQuery },
        { role: "assistant", content: summary.text },
        { role: "user", content: "Continue your research. You have already covered the above. Focus on remaining gaps." },
      ];
      compactedUpTo = messages.length;

      return { messages: compacted };
    } catch (error) {
      log.warn({ err: error }, "Context compaction failed, continuing without compaction");
      return carryForward();
    }
  };
}
