import { describe, test, expect, mock } from "bun:test";
import { MOCK_GATEWAY_ENV } from "./mock-env";

mock.module("../env", () => ({ env: { ...MOCK_GATEWAY_ENV } }));

const { computePrefixHashes } = await import("./ai-sdk");

describe("computePrefixHashes", () => {
  test("returns empty for missing messages field", () => {
    expect(computePrefixHashes("model", { prompt: "hi" })).toEqual([]);
  });

  test("single message produces one hash", () => {
    const hashes = computePrefixHashes("model", {
      messages: [{ role: "user", content: "Hi" }],
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

  const imageMessage = (url: string) => ({
    role: "user",
    content: [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url } },
    ],
  });

  test("tells two multimodal messages apart", () => {
    const a = computePrefixHashes("model", { messages: [imageMessage("xinity-media://aaa")] });
    const b = computePrefixHashes("model", { messages: [imageMessage("xinity-media://bbb")] });
    expect(a[0]).not.toBe(b[0]);
  });

  test("tells a multimodal message apart from text with the same words", () => {
    const parts = computePrefixHashes("model", { messages: [imageMessage("xinity-media://aaa")] });
    const text = computePrefixHashes("model", { messages: [{ role: "user", content: "What is this?" }] });
    expect(parts[0]).not.toBe(text[0]);
  });

  test("gives the same multimodal message the same hash across turns", () => {
    const a = computePrefixHashes("model", { messages: [imageMessage("xinity-media://aaa")] });
    const b = computePrefixHashes("model", { messages: [imageMessage("xinity-media://aaa")] });
    expect(a[0]).toBe(b[0]);
  });

  // /v1/responses names the conversation `input`, so reading only `messages` left every
  // request to that endpoint unhashed and therefore routed without prefix affinity.
  test("hashes a responses request, which carries `input`", () => {
    const hashes = computePrefixHashes("model", {
      input: [{ role: "user", content: "Hi" }],
    });
    expect(hashes).toHaveLength(1);
  });

  test("finds the previous turn of a responses conversation", () => {
    const turn1 = computePrefixHashes("model", {
      input: [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
      ],
    });
    const turn2 = computePrefixHashes("model", {
      input: [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
    });
    expect(turn2[turn2.length - 1]).toBe(turn1[0]);
  });

  test("hashes a bare string input as a single turn", () => {
    expect(computePrefixHashes("model", { input: "Hi" })).toHaveLength(1);
  });

  test("prefers messages when a request carries both", () => {
    const both = computePrefixHashes("model", {
      messages: [{ role: "user", content: "from messages" }],
      input: [{ role: "user", content: "from input" }],
    });
    const messagesOnly = computePrefixHashes("model", {
      messages: [{ role: "user", content: "from messages" }],
    });
    expect(both[0]).toBe(messagesOnly[0]);
  });

  test("tells assistant messages apart by their tool calls", () => {
    const withCall = (name: string) => ({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: "{}" } }],
    });
    const a = computePrefixHashes("model", { messages: [withCall("search")] });
    const b = computePrefixHashes("model", { messages: [withCall("fetch")] });
    expect(a[0]).not.toBe(b[0]);
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
