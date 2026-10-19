import { describe, test, expect } from "bun:test";
import { tensorParallelLayout } from "./tensor-parallel";

type Sizing = Parameters<typeof tensorParallelLayout>[0];
const layoutsUpTo = (sizing: Sizing, cards: number, kvCacheGb: number) =>
  Array.from({ length: cards }, (_, index) => tensorParallelLayout(sizing, { tensorParallelSize: index + 1, kvCacheGb })).filter((layout) => layout !== undefined);
const sizes = (sizing: Sizing, cards: number, kvCacheGb: number) => layoutsUpTo(sizing, cards, kvCacheGb).map((l) => l.tensorParallelSize);

describe("tensorParallelLayout", () => {
  const qwen38_27b = { weightGb: 26, attentionHeads: 24, kvHeads: 4 };

  test("allows only sizes the attention and kv heads both divide", () => {
    expect(sizes(qwen38_27b, 8, 16)).toEqual([1, 2, 4, 8]);
    expect(sizes({ weightGb: 8, attentionHeads: 24, kvHeads: 8 }, 8, 4)).toEqual([1, 2, 4, 8]);
  });

  test("splits weights and cache evenly while there are kv heads to split", () => {
    expect(tensorParallelLayout(qwen38_27b, { tensorParallelSize: 4, kvCacheGb: 16 })).toEqual({ tensorParallelSize: 4, perCardWeightGb: 6.5, perCardKvCacheGb: 4 });
  });

  test("stops shrinking the cache per card once every card holds a copy of one kv head", () => {
    const tp8 = tensorParallelLayout(qwen38_27b, { tensorParallelSize: 8, kvCacheGb: 16 })!;
    expect(tp8.perCardWeightGb).toBe(3.25);
    expect(tp8.perCardKvCacheGb).toBe(4);
  });

  test("keeps the whole latent cache on every card of an mla model", () => {
    const mistralSmall4 = { weightGb: 71, attentionHeads: 32, kvHeads: 32, mlaAttention: true };
    const layouts = layoutsUpTo(mistralSmall4, 4, 6);
    expect(layouts.map((l) => l.tensorParallelSize)).toEqual([1, 2, 4]);
    expect(layouts.map((l) => l.perCardKvCacheGb)).toEqual([6, 6, 6]);
  });

  test("keeps a model on one card when its head counts are not stated", () => {
    expect(sizes({ weightGb: 17, attentionHeads: 16 }, 8, 4)).toEqual([1]);
    expect(sizes({ weightGb: 17 }, 8, 4)).toEqual([1]);
  });
});
