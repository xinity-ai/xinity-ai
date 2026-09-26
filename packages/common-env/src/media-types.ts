/**
 * Media types a stored image or audio clip may carry.
 *
 * Every entry is an inert format. That is the point: these bytes are served back to a
 * browser, either from the dashboard's own origin or from a presigned S3 URL, so anything the
 * browser would execute while rendering becomes stored script running as the viewer. SVG carries
 * `<script>`, HTML is HTML, and PDF viewers run JavaScript, so none of them belong here.
 *
 * A separate entry point rather than part of the index, which reaches for `node:fs`.
 */

export const STORABLE_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/avif",
  "image/heic",
] as const;

export type StorableImageType = (typeof STORABLE_IMAGE_TYPES)[number];

export function isStorableImageType(value: string): value is StorableImageType {
  return (STORABLE_IMAGE_TYPES as readonly string[]).includes(value);
}

/** The formats OpenAI's `input_audio` part accepts, keyed by the name it uses for each. */
export const STORABLE_AUDIO_TYPES = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
} as const;

export type AudioFormat = keyof typeof STORABLE_AUDIO_TYPES;
export type StorableAudioType = (typeof STORABLE_AUDIO_TYPES)[AudioFormat];

export function isStorableAudioType(value: string): value is StorableAudioType {
  return (Object.values(STORABLE_AUDIO_TYPES) as string[]).includes(value);
}
