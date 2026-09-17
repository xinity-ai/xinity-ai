import { describe, test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { createSecretKeyring, createSecretUnsealer, isSealed } from "./secret-keyring";

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

describe("createSecretUnsealer", () => {
  const quiet = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as never;

  test("opens a sealed value and leaves an unsealed one alone", () => {
    const unseal = createSecretUnsealer({ current: A }, quiet);
    const sealed = createSecretKeyring({ current: A }).seal("hf_abc123");

    expect(unseal("VLLM_HF_TOKEN", sealed)).toBe("hf_abc123");
    expect(unseal("LOAD_BALANCE_STRATEGY", "round-robin")).toBe("round-robin");
  });

  test("gives up on a value sealed with a key this host does not have", () => {
    const unseal = createSecretUnsealer({ current: B }, quiet);

    expect(unseal("VLLM_HF_TOKEN", createSecretKeyring({ current: A }).seal("hf_abc123"))).toBeUndefined();
  });
});

describe("envelope versioning", () => {
  test("refuses a later envelope format instead of reading it as plaintext", () => {
    const ring = createSecretKeyring({ current: A });

    expect(isSealed("enc.v2:whatever")).toBe(true);
    expect(() => ring.open("enc.v2:whatever")).toThrow(/cannot open/);
  });
});
