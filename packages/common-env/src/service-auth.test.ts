import { describe, expect, test } from "bun:test";
import { createRequestVerifier, signRequest, verifyRequest, type SignedRequest } from "./service-auth";

const SECRET = "tether-secret-value";
const post: SignedRequest = { method: "POST", path: "/api/v1/status" };

describe("signRequest", () => {
  test("never carries the secret", () => {
    expect(signRequest(SECRET, post)).not.toContain(SECRET);
  });

  test("signs the same request differently each time", () => {
    expect(signRequest(SECRET, post)).not.toBe(signRequest(SECRET, post));
  });
});

describe("verifyRequest", () => {
  test("accepts what signRequest produced", () => {
    expect(verifyRequest(SECRET, signRequest(SECRET, post), post)).toEqual({ ok: true });
  });

  test("rejects a different secret", () => {
    expect(verifyRequest("other", signRequest(SECRET, post), post).ok).toBe(false);
  });

  test("refuses a signature re-pointed at another method or path", () => {
    const header = signRequest(SECRET, post);

    expect(verifyRequest(SECRET, header, { ...post, method: "DELETE" }).ok).toBe(false);
    expect(verifyRequest(SECRET, header, { ...post, path: "/api/v1/stream" }).ok).toBe(false);
  });

  test("separates a clock that drifted from a secret that is wrong", () => {
    const header = signRequest(SECRET, post);
    const wayLater = Date.now() + 10 * 60_000;

    expect(verifyRequest(SECRET, header, post, wayLater)).toEqual({ ok: false, reason: "stale" });
    expect(verifyRequest("other", header, post)).toEqual({ ok: false, reason: "mismatch" });
  });

  test("rejects a timestamp too far ahead, not only too far behind", () => {
    const header = signRequest(SECRET, post);

    expect(verifyRequest(SECRET, header, post, Date.now() - 10 * 60_000).ok).toBe(false);
  });

  test("names a header that is absent or not ours", () => {
    expect(verifyRequest(SECRET, null, post)).toEqual({ ok: false, reason: "missing" });
    expect(verifyRequest(SECRET, `Bearer ${SECRET}`, post)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyRequest(SECRET, "Xinity ts=abc,nonce=,mac=", post)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("createRequestVerifier", () => {
  test("accepts a signature once and refuses it when sent again", () => {
    const verify = createRequestVerifier();
    const header = signRequest(SECRET, post);

    expect(verify(SECRET, header, post)).toEqual({ ok: true });
    expect(verify(SECRET, header, post)).toEqual({ ok: false, reason: "replayed" });
  });

  test("keeps accepting fresh signatures after one was used", () => {
    const verify = createRequestVerifier();

    expect(verify(SECRET, signRequest(SECRET, post), post).ok).toBe(true);
    expect(verify(SECRET, signRequest(SECRET, post), post).ok).toBe(true);
  });

  test("does not remember a nonce whose signature failed", () => {
    const verify = createRequestVerifier();
    const header = signRequest(SECRET, post);

    expect(verify("other", header, post).ok).toBe(false);
    expect(verify(SECRET, header, post)).toEqual({ ok: true });
  });
});
