/**
 * Counts the tokens of a streamed generation from the usage the backend reports on its chunks,
 * so a stream that ends early is still recorded with what it used. With `continuous_usage_stats`,
 * vLLM puts a cumulative usage on every chunk: `prompt_tokens` for the call and
 * `completion_tokens` for the one choice of that chunk. A chunk with no choices carries the
 * final usage of the call.
 */
import type { z } from "zod";
import { BackendUsageSchema } from "./backend-schemas";

export type BackendUsage = NonNullable<z.infer<typeof BackendUsageSchema>>;

export type TrackedUsage = { inputTokens: number; outputTokens: number };

export type UsageTracker = {
  /** Starts the entry of the next backend call, for a run of several steps. */
  startCall(): void;
  observeChunk(usage: BackendUsage, choiceIndex: number): void;
  /** Takes the usage as final for the current backend call; later chunk usage of it is ignored. */
  observeFinal(usage: BackendUsage): void;
  /** Sum over all backend calls, or undefined when no call reported usage. */
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
      // The counts only grow, so a smaller value is a stale or reordered report.
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

/** Gives the usage of one parsed backend chunk to the tracker. Ignores anything without usage. */
export function observeParsedChunk(tracker: UsageTracker, chunk: unknown): void {
  if (typeof chunk !== "object" || chunk === null) {
    return;
  }
  const { usage: rawUsage, choices } = chunk as { usage?: unknown; choices?: unknown };
  const parsed = BackendUsageSchema.safeParse(rawUsage);
  if (!parsed.success || !parsed.data) {
    return;
  }
  // vLLM sends at most one choice per chunk.
  const firstChoice = Array.isArray(choices) ? choices[0] as { index?: unknown } | undefined : undefined;
  if (!firstChoice) {
    tracker.observeFinal(parsed.data);
    return;
  }
  tracker.observeChunk(parsed.data, typeof firstChoice.index === "number" ? firstChoice.index : 0);
}
