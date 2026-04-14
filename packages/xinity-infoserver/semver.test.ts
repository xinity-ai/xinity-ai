import { describe, test, expect } from "bun:test";
import { satisfiesMinVersion, normalizePep440 } from "./semver";

describe("normalizePep440", () => {
  test("strips leading v", () => {
    expect(normalizePep440("v0.19.1")).toBe("0.19.1");
  });

  test("extracts semver from PEP440 post release", () => {
    expect(normalizePep440("0.19.1.post1")).toBe("0.19.1");
  });

  test("extracts semver from PEP440 with local segment", () => {
    expect(normalizePep440("0.8.5.post1+cu126")).toBe("0.8.5");
  });

  test("extracts semver from PEP440 dev release", () => {
    expect(normalizePep440("0.20.0.dev3")).toBe("0.20.0");
  });

  test("passes through clean semver", () => {
    expect(normalizePep440("0.19.1")).toBe("0.19.1");
  });

  test("returns original string if no semver prefix found", () => {
    expect(normalizePep440("nightly")).toBe("nightly");
  });
});

describe("satisfiesMinVersion", () => {
  test("returns true when actual >= required", () => {
    expect(satisfiesMinVersion("0.20.0", "0.19.1")).toBe(true);
  });

  test("returns true when actual == required", () => {
    expect(satisfiesMinVersion("0.19.1", "0.19.1")).toBe(true);
  });

  test("returns false when actual < required", () => {
    expect(satisfiesMinVersion("0.18.0", "0.19.1")).toBe(false);
  });

  test("handles PEP440 actual versions", () => {
    expect(satisfiesMinVersion("0.19.1.post1+cu126", "0.19.1")).toBe(true);
    expect(satisfiesMinVersion("0.8.5.post1", "0.8.6")).toBe(false);
  });

  test("handles v-prefixed versions", () => {
    expect(satisfiesMinVersion("v0.19.1", "0.19.1")).toBe(true);
  });

  test("returns true when actual is empty (fail-open)", () => {
    expect(satisfiesMinVersion("", "0.19.1")).toBe(true);
  });

  test("returns true when minRequired is empty (fail-open)", () => {
    expect(satisfiesMinVersion("0.19.1", "")).toBe(true);
  });

  test("returns true when both are empty", () => {
    expect(satisfiesMinVersion("", "")).toBe(true);
  });

  test("returns true for unparseable actual (fail-open)", () => {
    expect(satisfiesMinVersion("nightly", "0.19.1")).toBe(true);
  });
});
