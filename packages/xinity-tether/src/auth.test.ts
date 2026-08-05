import { describe, test, expect, mock } from "bun:test";

mock.module("./env", () => ({
  env: { TETHER_SECRET: "test-secret-abc123" },
}));

const { verifyBearerToken } = await import("./auth");

describe("verifyBearerToken", () => {
  test("accepts valid bearer token", () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Bearer test-secret-abc123" },
    });
    expect(verifyBearerToken(req)).toBe(true);
  });

  test("rejects wrong token", () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Bearer wrong-secret" },
    });
    expect(verifyBearerToken(req)).toBe(false);
  });

  test("rejects missing authorization header", () => {
    const req = new Request("http://localhost");
    expect(verifyBearerToken(req)).toBe(false);
  });

  test("rejects non-bearer scheme", () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(verifyBearerToken(req)).toBe(false);
  });

  test("rejects empty bearer value", () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Bearer " },
    });
    expect(verifyBearerToken(req)).toBe(false);
  });
});
