import { describe, it, expect } from "bun:test";
import { EngineVersions, RelayedEngineVersions, ModelSizing } from "./model-definition";

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

describe("EngineVersions", () => {
  it("accepts a complete version", () => {
    expect(EngineVersions.parse({ min: "0.21.0" }).min).toBe("0.21.0");
  });

  it("rejects an engineVersions stating nothing", () => {
    expect(EngineVersions.safeParse({}).success).toBe(false);
    expect(EngineVersions.safeParse({ rules: [] }).success).toBe(false);
  });

  it("takes rules without a floor, since one can be known without the other", () => {
    const parsed = EngineVersions.parse({
      rules: [{ range: "0.27.1", effect: "blocked", reason: "engine crashes on the first request" }],
    });
    expect(parsed.min).toBeUndefined();
    expect(parsed.rules).toHaveLength(1);
  });

  it("rejects a rule naming an effect this version does not define", () => {
    expect(EngineVersions.safeParse({
      rules: [{ range: "0.27.1", effect: "preferred", reason: "x" }],
    }).success).toBe(false);
  });

  /**
   * Bun reads a malformed range as a wildcard, so an unchecked typo here excludes every
   * node instead of one release. This refusal is what keeps that out of the catalog.
   */
  it("rejects a rule whose range is not a range", () => {
    for (const range of ["0.27.1 or later", "^0.27.0", "0.27.x", "0.27"]) {
      expect(EngineVersions.safeParse({ rules: [{ range, effect: "blocked", reason: "x" }] }).success).toBe(false);
    }
  });

  /** An unreadable rule in someone else's catalog costs that rule, never the whole entry. */
  it("drops rules it cannot read from a relayed catalog instead of failing", () => {
    const parsed = RelayedEngineVersions.parse({
      min: "0.21.0",
      rules: [
        { range: "0.27.1", effect: "blocked", reason: "crashes" },
        { range: "0.28.0", effect: "preferred", reason: "an effect from a later version" },
        { range: "nonsense", effect: "blocked", reason: "an unreadable range" },
      ],
    });
    expect(parsed.rules).toEqual([{ range: "0.27.1", effect: "blocked", reason: "crashes" }]);
  });

  it("rejects the shapes a node reports but an author must not write", () => {
    for (const min of ["v0.21.0", "0.21.0.post1", "0.19.2rc1", "0.21", "latest"]) {
      expect(EngineVersions.safeParse({ min }).success).toBe(false);
    }
  });
});
