import { describe, it, expect } from "bun:test";
import { ModelSizing } from "./model-definition";

const base = { weightGb: 14, maxContextLength: 32768, kvBytesPerToken: 131072 };

function parse(overrides: Record<string, unknown> = {}) {
  return ModelSizing.parse({ ...base, ...overrides });
}

describe("ModelSizing minKvCacheGb", () => {
  it("derives the floor from one request at full context", () => {
    expect(parse().minKvCacheGb).toBe(4.3);
  });

  it("rounds the floor up, since a hair under it stops vllm booting", () => {
    // 131072 * 32768 is 4.294967296 GB exactly, which rounds down to 4.29.
    expect(parse().minKvCacheGb).toBeGreaterThan(4.294967296);
  });

  it("adds the per-sequence state a hybrid model reserves up front", () => {
    expect(parse({ stateBytesPerSequence: 20_000_000 }).minKvCacheGb).toBe(4.32);
  });

  it("stops charging for context past the attention window", () => {
    expect(parse({ attentionWindow: 4096 }).minKvCacheGb).toBe(0.54);
  });

  it("leaves an authored figure alone, treating it as a demand for more than the floor", () => {
    expect(parse({ minKvCacheGb: 8 }).minKvCacheGb).toBe(8);
  });

  it("still accepts an entry that states only the authored figure", () => {
    const { kvBytesPerToken, ...withoutPerToken } = base;
    expect(ModelSizing.parse({ ...withoutPerToken, minKvCacheGb: 6 }).minKvCacheGb).toBe(6);
  });

  it("rejects an entry that states neither, rather than defaulting the cache to nothing", () => {
    const { kvBytesPerToken, ...withoutPerToken } = base;
    expect(ModelSizing.safeParse(withoutPerToken).success).toBe(false);
  });
});
