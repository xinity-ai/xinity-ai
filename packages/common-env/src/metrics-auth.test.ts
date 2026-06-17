import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { parseMetricsAuth, authHeaderMatches, createMetricsAuth, metricsAuthSchema } from "./metrics-auth";

const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

describe("parseMetricsAuth", () => {
  test("returns no credentials when unset", () => {
    expect(parseMetricsAuth(undefined)).toEqual([]);
    expect(parseMetricsAuth("")).toEqual([]);
  });

  test("parses a single pair", () => {
    expect(parseMetricsAuth("admin:secret")).toEqual([{ user: "admin", pass: "secret" }]);
  });

  test("parses a comma-separated list", () => {
    expect(parseMetricsAuth("admin:secret,reader:abc123")).toEqual([
      { user: "admin", pass: "secret" },
      { user: "reader", pass: "abc123" },
    ]);
  });

  test("keeps colons in the password (splits on the first only)", () => {
    expect(parseMetricsAuth("admin:a:b:c")).toEqual([{ user: "admin", pass: "a:b:c" }]);
  });

  test("throws on an entry missing a colon", () => {
    expect(() => parseMetricsAuth("admin:secret,broken")).toThrow();
  });
});

describe("authHeaderMatches", () => {
  const creds = parseMetricsAuth("admin:secret,reader:abc123");

  test("accepts any configured pair", () => {
    expect(authHeaderMatches(creds, basic("admin", "secret"))).toBe(true);
    expect(authHeaderMatches(creds, basic("reader", "abc123"))).toBe(true);
  });

  test("rejects wrong password, unknown user, and cross-matched pairs", () => {
    expect(authHeaderMatches(creds, basic("admin", "wrong"))).toBe(false);
    expect(authHeaderMatches(creds, basic("ghost", "secret"))).toBe(false);
    expect(authHeaderMatches(creds, basic("admin", "abc123"))).toBe(false);
  });

  test("rejects a missing or non-Basic header", () => {
    expect(authHeaderMatches(creds, null)).toBe(false);
    expect(authHeaderMatches(creds, undefined)).toBe(false);
    expect(authHeaderMatches(creds, "Bearer token")).toBe(false);
  });

  test("rejects a malformed credential (no colon)", () => {
    expect(authHeaderMatches(creds, `Basic ${btoa("nocolon")}`)).toBe(false);
  });
});

describe("metricsAuthSchema", () => {
  const schema = z.object({ METRICS_AUTH: metricsAuthSchema() });

  test("accepts undefined and well-formed values", () => {
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ METRICS_AUTH: "admin:secret,reader:abc" }).success).toBe(true);
  });

  test("rejects a malformed value at parse time", () => {
    const result = schema.safeParse({ METRICS_AUTH: "broken" });
    expect(result.success).toBe(false);
  });

  test("stays a string (no type change for the CLI / env-file writers)", () => {
    const parsed = schema.parse({ METRICS_AUTH: "admin:secret" });
    expect(parsed.METRICS_AUTH).toBe("admin:secret");
  });
});

describe("createMetricsAuth", () => {
  test("is open (no auth required) when unset", () => {
    const auth = createMetricsAuth(undefined);
    expect(auth.isAuthorized(null)).toBe(true);
    expect(auth.unauthorized(null)).toBeNull();
  });

  test("requires a valid credential when configured", () => {
    const auth = createMetricsAuth("admin:secret");
    expect(auth.isAuthorized(basic("admin", "secret"))).toBe(true);
    expect(auth.isAuthorized(basic("admin", "wrong"))).toBe(false);
    expect(auth.isAuthorized(null)).toBe(false);
  });

  test("unauthorized() returns a 401 with a Basic challenge when denied", () => {
    const auth = createMetricsAuth("admin:secret");
    const res = auth.unauthorized(null);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(res!.headers.get("WWW-Authenticate")).toBe('Basic realm="metrics"');
    expect(auth.unauthorized(basic("admin", "secret"))).toBeNull();
  });
});
