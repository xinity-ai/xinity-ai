import { describe, test, expect, mock } from "bun:test";
import { signRequest, STATUS_PATH, STREAM_PATH } from "common-env";

const SECRET = "test-secret-abc123";

mock.module("./config", () => ({
  config: { tetherSecret: SECRET },
}));

const { verifySignature } = await import("./auth");

function post(header: string | null): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: header ? { Authorization: header } : {},
  });
}

describe("verifySignature", () => {
  test("accepts a request signed for this path", () => {
    const header = signRequest(SECRET, { method: "POST", path: STREAM_PATH });
    expect(verifySignature(post(header), STREAM_PATH)).toBeNull();
  });

  test("rejects a signature made for another endpoint", () => {
    const header = signRequest(SECRET, { method: "POST", path: STATUS_PATH });
    expect(verifySignature(post(header), STREAM_PATH)).toBe("mismatch");
  });

  test("rejects a bearer token carrying the raw secret", () => {
    expect(verifySignature(post(`Bearer ${SECRET}`), STATUS_PATH)).toBe("malformed");
  });

  test("rejects a missing authorization header", () => {
    expect(verifySignature(post(null), STATUS_PATH)).toBe("missing");
  });
});
