import { describe, test, expect } from "bun:test";
import { canonicalJson, jsonDigest, bytesDigest } from "./content-hash";

describe("canonicalJson", () => {
  test("orders keys, so two spellings of one object agree", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe(`{"a":2,"b":1}`);
  });

  test("orders keys at every depth", () => {
    const left = { outer: { b: [{ d: 1, c: 2 }], a: 3 } };
    const right = { outer: { a: 3, b: [{ c: 2, d: 1 }] } };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  test("keeps array order, which is meaning rather than spelling", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test("drops keys explicitly set to undefined, which JSON cannot represent anyway", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  test("keeps an absent key distinct from a null one", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 1, b: null }));
  });

  test("renders scalars and nulls the way JSON does", () => {
    expect(canonicalJson("x")).toBe(`"x"`);
    expect(canonicalJson(7)).toBe("7");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
  });

  test("escapes keys, so a key containing a quote cannot forge structure", () => {
    expect(canonicalJson({ 'a":1,"b': 2 })).toBe(`{"a\\":1,\\"b":2}`);
  });
});

describe("jsonDigest", () => {
  test("is independent of key order", () => {
    expect(jsonDigest({ role: "user", content: "Hi" })).toBe(jsonDigest({ content: "Hi", role: "user" }));
  });

  test("distinguishes different content", () => {
    expect(jsonDigest({ a: 1 })).not.toBe(jsonDigest({ a: 2 }));
  });

  test("is 64 hex characters", () => {
    expect(jsonDigest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("bytesDigest", () => {
  test("is stable for the same bytes and differs for others", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(bytesDigest(bytes)).toBe(bytesDigest(new Uint8Array([1, 2, 3])));
    expect(bytesDigest(bytes)).not.toBe(bytesDigest(new Uint8Array([1, 2, 4])));
  });

  test("is 64 hex characters", () => {
    expect(bytesDigest(new Uint8Array([0]))).toMatch(/^[0-9a-f]{64}$/);
  });

  test("matches the digest of the same bytes read as a known vector", () => {
    // sha256("abc"), the standard test vector.
    expect(bytesDigest(new TextEncoder().encode("abc")))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
