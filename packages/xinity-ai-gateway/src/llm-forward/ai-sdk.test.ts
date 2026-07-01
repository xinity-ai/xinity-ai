import { describe, test, expect, mock } from "bun:test";

mock.module("xinity-infoserver", () => ({
  createInfoserverClient: () => ({ fetchModel: async () => undefined }),
}));

const { computePrefixHashes } = await import("./ai-sdk");

describe("computePrefixHashes", () => {
  test("returns empty for missing messages field", () => {
    expect(computePrefixHashes("model", { prompt: "hi" })).toEqual([]);
  });

  test("returns empty for non-array messages", () => {
    expect(computePrefixHashes("model", { messages: "hi" })).toEqual([]);
  });

  test("returns empty for empty messages array", () => {
    expect(computePrefixHashes("model", { messages: [] })).toEqual([]);
  });

  test("single message produces one hash", () => {
    const hashes = computePrefixHashes("model", {
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toHaveLength(16);
  });

  test("two messages produce one hash", () => {
    const hashes = computePrefixHashes("model", {
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
      ],
    });
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toHaveLength(16);
  });

  test("three messages produce two hashes (longest first)", () => {
    const hashes = computePrefixHashes("model", {
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
      ],
    });
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  test("four messages produce two hashes", () => {
    const hashes = computePrefixHashes("model", {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
    });
    expect(hashes).toHaveLength(2);
  });

  test("longer prefix hash differs from shorter", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ];
    const hashes = computePrefixHashes("model", { messages: msgs });
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  test("cascade finds previous turn: hash of first 2 msgs matches across turns", () => {
    const turn1 = computePrefixHashes("model", {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
      ],
    });
    const turn2 = computePrefixHashes("model", {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
    });
    expect(turn2[turn2.length - 1]).toBe(turn1[0]);
  });

  test("different models produce different hashes", () => {
    const msgs = [{ role: "user", content: "Hi" }];
    const a = computePrefixHashes("model-a", { messages: msgs });
    const b = computePrefixHashes("model-b", { messages: msgs });
    expect(a[0]).not.toBe(b[0]);
  });

  test("handles null/undefined content gracefully", () => {
    const hashes = computePrefixHashes("model", {
      messages: [{ role: "user", content: null }],
    });
    expect(hashes).toHaveLength(1);
  });

  test("handles missing role and content", () => {
    const hashes = computePrefixHashes("model", {
      messages: [{}],
    });
    expect(hashes).toHaveLength(1);
  });

  test("caps at 10 cascade levels", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i}`,
    }));
    const hashes = computePrefixHashes("model", { messages });
    expect(hashes.length).toBeLessThanOrEqual(10);
  });
});
