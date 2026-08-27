import { describe, test, expect } from "bun:test";
import { satisfiesMinVersion, matchesVersionRange, isValidVersionRange } from "./semver";

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

  test("a pre-release does not satisfy the release it is on the way to", () => {
    expect(satisfiesMinVersion("0.23.1rc1.dev0+ge3e3cd545.d20260621.cu132", "0.23.1")).toBe(false);
    expect(satisfiesMinVersion("0.20.2.dev0+g132765e35.d20260521.cu132", "0.20.2")).toBe(false);
    expect(satisfiesMinVersion("0.19.2rc1.dev134+gfe9c3d6c5.cu130", "0.19.2")).toBe(false);
  });

  test("a pre-release still satisfies anything older", () => {
    expect(satisfiesMinVersion("0.23.1rc1.dev0+ge3e3cd545.d20260621.cu132", "0.23.0")).toBe(true);
    expect(satisfiesMinVersion("0.24.1.dev0+gee0da84ab.d20260708.cu132", "0.23.5")).toBe(true);
  });

  test("a pre-release requirement is met by that same pre-release", () => {
    expect(satisfiesMinVersion("0.23.1rc1", "0.23.1rc1")).toBe(true);
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

  /** Why pre-releases are ranked here rather than emitted as semver pre-releases. */
  test("Bun keeps a semver pre-release out of ranges that do not name it", () => {
    expect(Bun.semver.satisfies("0.23.1-rc.1", ">=0.23.0")).toBe(false);
  });
});

describe("matchesVersionRange", () => {
  test("reads a bare version as an exact match, not a floor", () => {
    expect(matchesVersionRange("0.27.1", "0.27.1")).toBe(true);
    expect(matchesVersionRange("0.27.2", "0.27.1")).toBe(false);
  });

  test("ANDs comparators separated by a space", () => {
    expect(matchesVersionRange("0.27.1", ">=0.27.0 <0.27.3")).toBe(true);
    expect(matchesVersionRange("0.27.3", ">=0.27.0 <0.27.3")).toBe(false);
    expect(matchesVersionRange("0.26.9", ">=0.27.0 <0.27.3")).toBe(false);
  });

  test("ORs clauses separated by ||", () => {
    expect(matchesVersionRange("0.21.4", "0.21.4 || >=0.27.0 <0.27.3")).toBe(true);
    expect(matchesVersionRange("0.27.1", "0.21.4 || >=0.27.0 <0.27.3")).toBe(true);
    expect(matchesVersionRange("0.24.0", "0.21.4 || >=0.27.0 <0.27.3")).toBe(false);
  });

  test("normalizes a PEP440 actual version before comparing", () => {
    expect(matchesVersionRange("0.27.1.post1+cu126", "0.27.1")).toBe(true);
  });

  test("does not match when the actual version is unknown or unparseable", () => {
    expect(matchesVersionRange("", "0.27.1")).toBe(false);
    expect(matchesVersionRange("nightly", ">=0.0.0")).toBe(false);
  });

  test("does not match on an empty or malformed range", () => {
    expect(matchesVersionRange("0.27.1", "")).toBe(false);
    expect(matchesVersionRange("0.27.1", "not a range")).toBe(false);
  });
});

describe("isValidVersionRange", () => {
  test("accepts a bare version, a comparator, and both combined", () => {
    expect(isValidVersionRange("0.27.1")).toBe(true);
    expect(isValidVersionRange(">=0.27.0")).toBe(true);
    expect(isValidVersionRange(">=0.27.0 <0.27.3")).toBe(true);
    expect(isValidVersionRange("0.21.4 || >=0.27.0 <0.27.3")).toBe(true);
  });

  test("accepts every comparator operator", () => {
    for (const range of ["<0.27.1", "<=0.27.1", ">0.27.1", ">=0.27.1", "=0.27.1"]) {
      expect(isValidVersionRange(range)).toBe(true);
    }
  });

  test("rejects the shorthands an exclusion should not be written with", () => {
    expect(isValidVersionRange("^0.27.0")).toBe(false);
    expect(isValidVersionRange("~0.27.0")).toBe(false);
    expect(isValidVersionRange("0.27.x")).toBe(false);
    expect(isValidVersionRange("*")).toBe(false);
    expect(isValidVersionRange("0.27.0 - 0.27.3")).toBe(false);
  });

  test("rejects a partial version, since 0.27 could mean either bound", () => {
    expect(isValidVersionRange("0.27")).toBe(false);
    expect(isValidVersionRange(">=0.27")).toBe(false);
  });

  test("rejects empty and half-written ranges", () => {
    expect(isValidVersionRange("")).toBe(false);
    expect(isValidVersionRange("   ")).toBe(false);
    expect(isValidVersionRange("0.27.1 ||")).toBe(false);
    expect(isValidVersionRange("not a range")).toBe(false);
  });

  /** Fails if Bun starts rejecting malformed ranges, which is the signal to drop the guard. */
  test("Bun reads an unparseable range as a wildcard", () => {
    expect(Bun.semver.satisfies("9.9.9", "not a range")).toBe(true);

    expect(isValidVersionRange("not a range")).toBe(false);
    expect(matchesVersionRange("9.9.9", "not a range")).toBe(false);
  });
});
