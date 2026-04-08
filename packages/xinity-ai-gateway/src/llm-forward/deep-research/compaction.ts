import { generateText, type ModelMessage } from "ai";
import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { COMPACTION_SYSTEM_PROMPT } from "./prompts";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "deep-research-compaction" });

type StepWithUsage = {
  usage?: { inputTokens?: number; outputTokens?: number };
};

function estimateStepTokens(steps: ReadonlyArray<StepWithUsage>): number {
  let total = 0;
  for (const step of steps) {
    total += step.usage?.inputTokens ?? 0;
    total += step.usage?.outputTokens ?? 0;
  }
  return total;
}

/**
 * Creates a `prepareStep` callback that compacts the conversation context
 * when accumulated token usage approaches the model's context limit.
 *
 * When usage exceeds `contextLimit * compactionThreshold`, the callback
 * summarises all research so far into a single message and replaces the
 * step history, freeing context for continued research.
 */
export function createCompactionStep(
  provider: OpenAICompatibleProvider,
  modelId: string,
  contextLimit: number,
  compactionThreshold: number,
  originalUserQuery: string,
) {
  const threshold = Math.floor(contextLimit * compactionThreshold);

  return async ({ steps, messages }: { steps: ReadonlyArray<StepWithUsage>; messages: ModelMessage[] }) => {
    if (steps.length === 0) return {};

    const currentTokens = estimateStepTokens(steps);
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
