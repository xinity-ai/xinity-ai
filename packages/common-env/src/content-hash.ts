/**
 * Content addressing for the deduplicated stores: an identity derived from a value's bytes, so
 * the same content resolves to the same row whoever sends it and however they spell it.
 *
 * Uses Bun's hasher, so this is server side only.
 */

/** Key order must not reach the digest, or deduplication silently degrades to nothing. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}

/** The content address of raw bytes, as stored media is identified by. */
export function bytesDigest(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** The content address of a JSON value, independent of key order and whitespace. */
export function jsonDigest(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");
}
