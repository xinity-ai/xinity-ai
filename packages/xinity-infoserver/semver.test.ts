import { describe, test, expect } from "bun:test";
import { satisfiesMinVersion } from "./semver";

describe("satisfiesMinVersion", () => {
  test("returns true when actual >= required", () => {
    expect(satisfiesMinVersion("0.20.0", "0.19.1")).toBe(true);
  });

  test("returns false when actual < required", () => {
    expect(satisfiesMinVersion("0.18.0", "0.19.1")).toBe(false);
  });

  test("handles PEP440 actual versions", () => {
    expect(satisfiesMinVersion("0.19.1.post1+cu126", "0.19.1")).toBe(true);
    expect(satisfiesMinVersion("0.8.5.post1", "0.8.6")).toBe(false);
  });

  test("returns true when actual is empty (fail-open)", () => {
    expect(satisfiesMinVersion("", "0.19.1")).toBe(true);
  });

  test("returns true when minRequired is empty (fail-open)", () => {
    expect(satisfiesMinVersion("0.19.1", "")).toBe(true);
  });

  test("returns true for unparseable actual (fail-open)", () => {
    expect(satisfiesMinVersion("nightly", "0.19.1")).toBe(true);
  });
});
