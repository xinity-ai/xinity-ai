import { describe, test, expect } from "bun:test";
import { formatMediaRef, parseMediaRef } from "./media-ref";
import { bytesDigest } from "./content-hash";

/** sha256("abc"), the published test vector, so the expected digest is checkable by hand. */
const IMAGE_BYTES = new TextEncoder().encode("abc");
const DIGEST = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("media references", () => {
  test("carry a stored image's digest there and back", () => {
    expect(bytesDigest(IMAGE_BYTES)).toBe(DIGEST);
    expect(parseMediaRef(formatMediaRef(bytesDigest(IMAGE_BYTES)))).toBe(DIGEST);
  });

  // The url a client sent, which must never be mistaken for a reference to stored content.
  test("are distinguishable from the image urls a request can contain", () => {
    expect(parseMediaRef(`https://example.com/${DIGEST}.png`)).toBeNull();
    expect(parseMediaRef("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
    expect(parseMediaRef("")).toBeNull();
  });

  // The digest becomes an S3 key and a /data/media/ path segment, so a host that cannot be a
  // digest has to be rejected here rather than by whatever it would otherwise be handed to.
  test("resolve to nothing when the host could not be a digest", () => {
    expect(parseMediaRef("xinity-media://../../etc/passwd")).toBeNull();
    expect(parseMediaRef(`xinity-media://${DIGEST.slice(0, 63)}`)).toBeNull();
    expect(parseMediaRef(`xinity-media://${DIGEST}/../../other`)).toBeNull();
  });

  // Stored digests are lowercase hex, so accepting any other casing would resolve a reference
  // to a key that was never written.
  test("match a digest case sensitively", () => {
    expect(parseMediaRef(`xinity-media://${DIGEST.toUpperCase()}`)).toBeNull();
  });
});
