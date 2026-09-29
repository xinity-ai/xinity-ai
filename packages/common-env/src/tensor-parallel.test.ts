import { describe, test, expect } from "bun:test";
import { tensorParallelLayouts } from "./tensor-parallel";

const sizes = (layouts: { tensorParallelSize: number }[]) => layouts.map((l) => l.tensorParallelSize);

describe("tensorParallelLayouts", () => {
  const qwen38_27b = { weightGb: 26, attentionHeads: 24, kvHeads: 4 };

  test("offers only sizes the attention and kv heads both divide", () => {
    expect(sizes(tensorParallelLayouts(qwen38_27b, { cards: 8, kvCacheGb: 16 }))).toEqual([1, 2, 4, 8]);
    expect(sizes(tensorParallelLayouts({ weightGb: 8, attentionHeads: 24, kvHeads: 8 }, { cards: 8, kvCacheGb: 4 })))
      .toEqual([1, 2, 4, 8]);
  });

  test("never offers more cards than the node has", () => {
    expect(sizes(tensorParallelLayouts(qwen38_27b, { cards: 2, kvCacheGb: 16 }))).toEqual([1, 2]);
  });

  test("splits weights and cache evenly while there are kv heads to split", () => {
    const [, , tp4] = tensorParallelLayouts(qwen38_27b, { cards: 4, kvCacheGb: 16 });
    expect(tp4).toEqual({ tensorParallelSize: 4, perCardWeightGb: 6.5, perCardKvCacheGb: 4 });
  });

  test("stops shrinking the cache per card once every card holds a copy of one kv head", () => {
    const tp8 = tensorParallelLayouts(qwen38_27b, { cards: 8, kvCacheGb: 16 }).at(-1)!;
    expect(tp8.perCardWeightGb).toBe(3.25);
    expect(tp8.perCardKvCacheGb).toBe(4);
  });

  test("keeps the whole latent cache on every card of an mla model", () => {
    const mistralSmall4 = { weightGb: 71, attentionHeads: 32, kvHeads: 32, mlaAttention: true };
    const layouts = tensorParallelLayouts(mistralSmall4, { cards: 4, kvCacheGb: 6 });
    expect(sizes(layouts)).toEqual([1, 2, 4]);
    expect(layouts.map((l) => l.perCardKvCacheGb)).toEqual([6, 6, 6]);
  });

  test("keeps a model on one card when its head counts are not stated", () => {
    expect(sizes(tensorParallelLayouts({ weightGb: 17, attentionHeads: 16 }, { cards: 8, kvCacheGb: 4 }))).toEqual([1]);
    expect(sizes(tensorParallelLayouts({ weightGb: 17 }, { cards: 8, kvCacheGb: 4 }))).toEqual([1]);
  });
});
