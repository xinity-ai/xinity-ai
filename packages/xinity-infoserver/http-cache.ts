/**
 * Conditional-request matching for the precomputed catalog bodies.
 */

/**
 * Compares an If-None-Match header against a strong ETag. Accepts the header's
 * comma-separated list form and `*`, and ignores the weak-validator prefix so a
 * proxy that weakened the tag still gets a 304.
 */
export function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }
  if (ifNoneMatch.trim() === "*") {
    return true;
  }
  return ifNoneMatch
    .split(",")
    .some(candidate => candidate.trim().replace(/^W\//, "") === etag);
}
