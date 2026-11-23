import type { z } from "zod";
import { BackendUsageSchema } from "./backend-schemas";

export type BackendUsage = NonNullable<z.infer<typeof BackendUsageSchema>>;

export type TrackedUsage = { inputTokens: number; outputTokens: number };

export type UsageTracker = {
  startCall(): void;
  observeChunk(usage: BackendUsage, choiceIndex: number): void;
  observeFinal(usage: BackendUsage): void;
  total(): TrackedUsage | undefined;
};

type CallEntry = {
  promptTokens: number;
  completionByChoice: Map<number, number>;
  final?: TrackedUsage;
};

export function createUsageTracker(): UsageTracker {
  const calls: CallEntry[] = [];
  let current: CallEntry | undefined;

  const openEntry = (): CallEntry => {
    if (!current) {
      current = { promptTokens: 0, completionByChoice: new Map() };
      calls.push(current);
    }
    return current;
  };

  return {
    startCall() {
      current = undefined;
    },
    observeChunk(usage, choiceIndex) {
      const entry = openEntry();
      if (entry.final) {
        return;
      }
      entry.promptTokens = Math.max(entry.promptTokens, usage.prompt_tokens);
      const previous = entry.completionByChoice.get(choiceIndex) ?? 0;
      entry.completionByChoice.set(choiceIndex, Math.max(previous, usage.completion_tokens));
    },
    observeFinal(usage) {
      openEntry().final = { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
    },
    total() {
      if (calls.length === 0) {
        return undefined;
      }
      let inputTokens = 0;
      let outputTokens = 0;
      for (const entry of calls) {
        if (entry.final) {
          inputTokens += entry.final.inputTokens;
          outputTokens += entry.final.outputTokens;
          continue;
        }
        inputTokens += entry.promptTokens;
        for (const completion of entry.completionByChoice.values()) {
          outputTokens += completion;
        }
      }
      return { inputTokens, outputTokens };
    },
  };
}

export function observeParsedChunk(tracker: UsageTracker, chunk: unknown): void {
  if (typeof chunk !== "object" || chunk === null) {
    return;
  }
  const { usage: rawUsage, choices } = chunk as { usage?: unknown; choices?: unknown };
  const parsed = BackendUsageSchema.safeParse(rawUsage);
  if (!parsed.success || !parsed.data) {
    return;
  }
  const firstChoice = Array.isArray(choices) ? choices[0] as { index?: unknown } | undefined : undefined;
  if (!firstChoice) {
    tracker.observeFinal(parsed.data);
    return;
  }
  tracker.observeChunk(parsed.data, typeof firstChoice.index === "number" ? firstChoice.index : 0);
}
