/**
 * Lightweight version comparison helpers.
 * Uses Bun's built-in semver module for the actual comparison.
 * Handles PEP440 versions (vLLM) by normalizing to semver first.
 */

const SEMVER_PREFIX = /^\d+\.\d+\.\d+/;

/**
 * Normalizes a version string that may be PEP440 (e.g. "0.19.1.post1",
 * "0.8.5.post1+cu126", "0.8.5.dev3") to a semver-compatible "major.minor.patch".
 * Also strips leading "v".
 */
export function normalizePep440(version: string): string {
  let v = version.trim();
  if (v.startsWith("v")) v = v.slice(1);
  // Extract major.minor.patch, dropping PEP440 suffixes (.postN, .devN, +local)
  return v.match(/^(\d+\.\d+\.\d+)/)?.[1] ?? v;
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
