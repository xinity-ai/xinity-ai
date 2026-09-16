import { describe, test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { createSecretKeyring, isSealed } from "./secret-keyring";

const key = () => randomBytes(32).toString("base64");

const A = key();
const B = key();

describe("createSecretKeyring", () => {
  test("rejects a key that is not 32 bytes", () => {
    expect(() => createSecretKeyring({ current: randomBytes(16).toString("base64") })).toThrow(/32 bytes/);
  });

  test("seals and opens a round trip", () => {
    const ring = createSecretKeyring({ current: A });
    expect(ring.open(ring.seal("hf_abc123"))).toBe("hf_abc123");
  });

  test("seals the same plaintext to different envelopes", () => {
    const ring = createSecretKeyring({ current: A });
    expect(ring.seal("same")).not.toBe(ring.seal("same"));
  });

  test("passes a value that was never sealed straight through", () => {
    const ring = createSecretKeyring({ current: A });
    expect(ring.open("round-robin")).toBe("round-robin");
    expect(isSealed("round-robin")).toBe(false);
  });

  test("refuses a tampered envelope", () => {
    const ring = createSecretKeyring({ current: A });
    const sealed = ring.seal("hf_abc123");
    const parts = sealed.split(":");
    parts[3] = Buffer.from("hf_evil00").toString("base64url");
    expect(() => ring.open(parts.join(":"))).toThrow();
  });

  test("names the sealing key when no configured key matches", () => {
    const sealed = createSecretKeyring({ current: A }).seal("hf_abc123");
    expect(() => createSecretKeyring({ current: B }).open(sealed)).toThrow(/sealed with key/);
  });

  test("opens with the previous key after rotation, and seals with the current one", () => {
    const old = createSecretKeyring({ current: A }).seal("hf_abc123");
    const rotated = createSecretKeyring({ current: B, previous: A });

    expect(rotated.open(old)).toBe("hf_abc123");
    expect(rotated.open(rotated.seal("hf_new"))).toBe("hf_new");
    expect(() => createSecretKeyring({ current: B }).open(rotated.seal("hf_new"))).not.toThrow();
  });

  test("digests a value the same way twice and differently per value", () => {
    const ring = createSecretKeyring({ current: A });
    expect(ring.digest("hf_abc123")).toBe(ring.digest("hf_abc123"));
    expect(ring.digest("hf_abc123")).not.toBe(ring.digest("hf_abc124"));
  });

  test("does not reuse the raw key as the HMAC key", () => {
    const ring = createSecretKeyring({ current: A });
    const sealed = ring.seal("hf_abc123");
    expect(sealed).not.toContain(ring.digest("hf_abc123"));
  });
});
