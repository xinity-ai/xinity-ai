/**
 * The `xinity-media://<sha256>` reference that stands in for an image inside a logged message
 * payload, naming a `media_object` row and the S3 object it describes.
 *
 * A separate entry point rather than part of the index, because the browser resolves references
 * for display and the index reaches for `node:fs`.
 */

const MEDIA_REF_PROTOCOL = "xinity-media:";
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Whether a string is the hex-encoded SHA-256 that identifies a media object. */
export function isMediaDigest(value: string): boolean {
  return SHA256_HEX.test(value);
}

export function formatMediaRef(sha256: string): string {
  return `${MEDIA_REF_PROTOCOL}//${sha256}`;
}

/** The digest a reference names, or null when `url` is anything else. */
export function parseMediaRef(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== MEDIA_REF_PROTOCOL) {
    return null;
  }
  // A reference is exactly the digest. Anything trailing it would otherwise be dropped in
  // silence, leaving two spellings that resolve to one object.
  if (parsed.pathname !== "" || parsed.search !== "" || parsed.hash !== "") {
    return null;
  }
  return isMediaDigest(parsed.hostname) ? parsed.hostname : null;
}
