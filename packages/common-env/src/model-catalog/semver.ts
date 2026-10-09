/**
 * Lightweight version comparison helpers.
 * Uses Bun's built-in semver module for the actual comparison.
 * Handles PEP440 versions (vLLM) by normalizing to semver first.
 */

const SEMVER_PREFIX = /^\d+\.\d+\.\d+/;

/** rcN/aN/bN and .devN name a build that comes BEFORE the release in the string. */
const PEP440_PRE_RELEASE = /(?:a|b|rc)\d+|\.dev\d+/;

/**
 * Normalizes a version string that may be PEP440 (e.g. "0.19.1.post1",
 * "0.8.5.post1+cu126", "0.8.5.dev3") to a semver-compatible "major.minor.patch".
 * Also strips leading "v". Pre-release markers are dropped here and accounted
 * for by satisfiesMinVersion.
 */
export function normalizePep440(version: string): string {
  let v = version.trim();
  if (v.startsWith("v")) v = v.slice(1);
  // Extract major.minor.patch, dropping PEP440 suffixes (.postN, .devN, +local)
  return v.match(/^(\d+\.\d+\.\d+)/)?.[1] ?? v;
}

function isPep440PreRelease(version: string): boolean {
  return PEP440_PRE_RELEASE.test(version.trim().replace(/\+.*$/, ""));
}

/**
 * Returns true if `actual` satisfies `>= minRequired`.
 * Fail-open: returns true when either version is empty or unparseable,
 * so missing version data never blocks scheduling.
 */
export function satisfiesMinVersion(actual: string, minRequired: string): boolean {
  if (!actual || !minRequired) return true;
  const normalized = normalizePep440(actual);
  const normalizedMin = normalizePep440(minRequired);
  // If normalization didn't produce a valid semver prefix, fail-open
  if (!SEMVER_PREFIX.test(normalized)) return true;
  // "0.23.1rc1.dev0" normalizes equal to "0.23.1" but is a build on the way to
  // it, so it must not satisfy a requirement for the finished release. Anything
  // older than that release still compares normally.
  if (normalized === normalizedMin && isPep440PreRelease(actual) && !isPep440PreRelease(minRequired)) {
    return false;
  }
  try {
    return Bun.semver.satisfies(normalized, `>=${normalizedMin}`);
  } catch {
    return true;
  }
}

/** Bun reads a range it cannot parse as a wildcard, so vet it before trusting a match. */
export function matchesVersionRange(actual: string, range: string): boolean {
  if (!actual || !isValidVersionRange(range)) {
    return false;
  }
  const normalized = normalizePep440(actual);
  if (!SEMVER_PREFIX.test(normalized)) {
    return false;
  }
  return Bun.semver.satisfies(normalized, range);
}

const COMPARATOR = /^(?:<=|>=|<|>|=)?\d+\.\d+\.\d+$/;

/** Comparators ANDed by spaces, ORed by "||". Narrow on purpose: an exclusion is a concrete interval. */
export function isValidVersionRange(range: string): boolean {
  return range.split("||").every(clause =>
    clause.trim().split(/\s+/).every(comparator => COMPARATOR.test(comparator)),
  );
}
