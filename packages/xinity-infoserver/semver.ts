/**
 * Lightweight version comparison helpers.
 * Uses Bun's built-in semver module for the actual comparison.
 * Handles PEP440 versions (vLLM) by normalizing to semver first.
 */

/**
 * Normalizes a version string that may be PEP440 (e.g. "0.19.1.post1",
 * "0.8.5.post1+cu126", "0.8.5.dev3") to a semver-compatible "major.minor.patch".
 * Also strips leading "v".
 */
export function normalizePep440(version: string): string {
  let v = version.trim();
  if (v.startsWith("v")) v = v.slice(1);
  // Extract major.minor.patch, dropping PEP440 suffixes (.postN, .devN, +local)
  const match = v.match(/^(\d+\.\d+\.\d+)/);
  return match ? match[1] : v;
}

/**
 * Returns true if `actual` satisfies `>= minRequired`.
 * Fail-open: returns true when either version is empty or unparseable,
 * so missing version data never blocks scheduling.
 */
export function satisfiesMinVersion(actual: string, minRequired: string): boolean {
  if (!actual || !minRequired) return true;
  const normalized = normalizePep440(actual);
  // If normalization didn't produce a valid semver prefix, fail-open
  if (!/^\d+\.\d+\.\d+/.test(normalized)) return true;
  try {
    return Bun.semver.satisfies(normalized, `>=${minRequired}`);
  } catch {
    return true;
  }
}
