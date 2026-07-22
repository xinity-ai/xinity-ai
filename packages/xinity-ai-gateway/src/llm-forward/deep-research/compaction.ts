import { generateText, type ModelMessage } from "ai";
import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { COMPACTION_SYSTEM_PROMPT } from "./prompts";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "deep-research-compaction" });

type StepWithUsage = {
  usage?: { inputTokens?: number; outputTokens?: number };
};

function lastStepInputTokens(steps: ReadonlyArray<StepWithUsage>): number {
  const last = steps[steps.length - 1];
  return last?.usage?.inputTokens ?? 0;
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

  return async ({ steps, messages }: { steps: ReadonlyArray<StepWithUsage>; messages: ModelMessage[] }) => {
    if (steps.length === 0) return {};

    const currentTokens = lastStepInputTokens(steps);
    if (currentTokens < threshold) return {};

    log.info(
      { currentTokens, threshold, stepCount: steps.length },
      "Context compaction triggered",
    );

    try {
      const summary = await generateText({
        model: provider.chatModel(modelId),
        system: COMPACTION_SYSTEM_PROMPT,
        messages,
        maxRetries: 1,
      });

      if (summary.usage && onCompactionUsage) {
        onCompactionUsage({
          inputTokens: summary.usage.inputTokens ?? 0,
          outputTokens: summary.usage.outputTokens ?? 0,
        });
      }

      return {
        messages: [
          { role: "user" as const, content: originalUserQuery },
          { role: "assistant" as const, content: summary.text },
          { role: "user" as const, content: "Continue your research. You have already covered the above. Focus on remaining gaps." },
        ],
      };
    } catch (error) {
      log.warn({ err: error }, "Context compaction failed, continuing without compaction");
      return {};
    }
  };
}
