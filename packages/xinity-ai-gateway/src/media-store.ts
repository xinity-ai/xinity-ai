/**
 * Multimodal image and audio handling. Inference nodes always receive the resolved bytes, and the
 * database always receives a `xinity-media://` reference, whether the bytes went to S3 or
 * into `media_object` itself.
 */
import type { S3Client } from "bun";
import { mediaObjectT, sql, type ApiCallInputMessage, type ApiCallInputMessageContent } from "common-db";
import { bytesDigest } from "common-env";
import { formatMediaRef, parseMediaRef } from "common-env/media-ref";
import {
  isStorableImageType,
  STORABLE_AUDIO_TYPES,
  STORABLE_IMAGE_TYPES,
  type AudioFormat,
  type StorableAudioType,
  type StorableImageType,
} from "common-env/media-types";
import { rootLogger } from "./logger";
import { getDB } from "./db";
import { config } from "./config";
import type { GatewayConfig } from "./config-schema";
import { safeFetch } from "./llm-forward/tools/url-safety";

const log = rootLogger.child({ name: "media-store" });

export type MediaStore = {
  client: S3Client;
  bucket: string;
}

export function createMediaStore(s3: GatewayConfig["s3"]): MediaStore | null {
  if (!s3) {
    return null;
  }
  return { client: new Bun.S3Client(s3), bucket: s3.bucket };
}

type ResolvedImage = { mimeType: string; bytes: Uint8Array<ArrayBuffer> };

const MAX_MEDIA_BYTES = 40 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const MEDIA_TOO_LARGE = "media_too_large";

/** Rejected rather than dropped: a picture or clip missing from the log is missing from the
 * conversation every later turn replays. */
function mediaTooLargeError(kind: "Image" | "Audio", size: number): Error {
  const limitMb = Math.floor(MAX_MEDIA_BYTES / (1024 * 1024));
  return Object.assign(
    new Error(`${kind} is ${size} bytes, over the ${limitMb}MB limit`),
    { code: MEDIA_TOO_LARGE },
  );
}

export function isMediaTooLarge(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === MEDIA_TOO_LARGE;
}

const MEDIA_TYPE_UNSUPPORTED = "media_type_unsupported";

/** Refused rather than stored: these bytes are served back to a browser later. */
function imageTypeUnsupportedError(declared: string): Error {
  return Object.assign(
    new Error(`Image type ${declared || "unknown"} is not supported. Supported: ${STORABLE_IMAGE_TYPES.join(", ")}`),
    { code: MEDIA_TYPE_UNSUPPORTED },
  );
}

export function isMediaTypeUnsupported(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === MEDIA_TYPE_UNSUPPORTED;
}

const MEDIA_PART_INVALID = "media_part_invalid";

/** OpenAI answers a malformed content part with a 400, and so do we. */
function mediaPartInvalidError(message: string): Error {
  return Object.assign(new Error(message), { code: MEDIA_PART_INVALID });
}

export function isMediaPartInvalid(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === MEDIA_PART_INVALID;
}

function isAudioFormat(value: string): value is AudioFormat {
  return Object.hasOwn(STORABLE_AUDIO_TYPES, value);
}

const MAGIC: Array<{ type: StorableImageType; matches: (b: Uint8Array) => boolean }> = [
  { type: "image/png", matches: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { type: "image/jpeg", matches: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  { type: "image/gif", matches: (b) => starts(b, [0x47, 0x49, 0x46, 0x38]) },
  { type: "image/bmp", matches: (b) => starts(b, [0x42, 0x4d]) },
  { type: "image/tiff", matches: (b) => starts(b, [0x49, 0x49, 0x2a, 0x00]) || starts(b, [0x4d, 0x4d, 0x00, 0x2a]) },
  { type: "image/webp", matches: (b) => starts(b, [0x52, 0x49, 0x46, 0x46]) && tagAt(b, 8) === "WEBP" },
  { type: "image/avif", matches: (b) => tagAt(b, 4) === "ftyp" && tagAt(b, 8) === "avif" },
  { type: "image/heic", matches: (b) => tagAt(b, 4) === "ftyp" && ["heic", "heix", "mif1"].includes(tagAt(b, 8)) },
];

function starts(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function tagAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/**
 * The bytes are the only trustworthy source. A data URI carries whatever the client declared, and
 * an external server may send a wrong `content-type` or none at all, but the stored type ends up
 * on the S3 object and decides whether a browser renders it or downloads it.
 */
export function sniffImageType(bytes: Uint8Array): StorableImageType | null {
  return MAGIC.find((format) => format.matches(bytes))?.type ?? null;
}

const LAYER3_KBPS = {
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MPEG_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};
const MP3_SCAN_BYTES = 4096;

function layer3FrameLength(b: Uint8Array, offset: number): number | null {
  const b1 = b[offset + 1];
  const b2 = b[offset + 2];
  if (b[offset] !== 0xff || b1 === undefined || b2 === undefined) {
    return null;
  }
  if ((b1 & 0xe0) !== 0xe0 || ((b1 >> 1) & 3) !== 1) {
    return null;
  }
  const version = (b1 >> 3) & 3;
  const sampleRate = MPEG_SAMPLE_RATES[version]?.[(b2 >> 2) & 3];
  const kbps = (version === 3 ? LAYER3_KBPS.mpeg1 : LAYER3_KBPS.mpeg2)[b2 >> 4];
  if (!sampleRate || !kbps) {
    return null;
  }
  const bytesPerKbps = version === 3 ? 144 : 72;
  return Math.floor((bytesPerKbps * kbps * 1000) / sampleRate) + ((b2 >> 1) & 1);
}

// Encoders and stream cuts can leave junk before the first frame, so the header is searched for.
// A lone 0xFF 0xFB pair turns up in arbitrary bytes, so it only counts when the next frame begins
// exactly where this one ends, or when the clip ends first.
function looksLikeMp3(b: Uint8Array): boolean {
  if (tagAt(b, 0).startsWith("ID3")) {
    return true;
  }
  const scanEnd = Math.min(b.length, MP3_SCAN_BYTES);
  for (let offset = 0; offset < scanEnd; offset++) {
    const length = layer3FrameLength(b, offset);
    if (length !== null && (offset + length >= b.length || layer3FrameLength(b, offset + length) !== null)) {
      return true;
    }
  }
  return false;
}

const AUDIO_MAGIC: Array<{ format: AudioFormat; matches: (b: Uint8Array) => boolean }> = [
  { format: "wav", matches: (b) => tagAt(b, 0) === "RIFF" && tagAt(b, 8) === "WAVE" },
  { format: "mp3", matches: looksLikeMp3 },
];

export function sniffAudioFormat(bytes: Uint8Array): AudioFormat | null {
  return AUDIO_MAGIC.find((entry) => entry.matches(bytes))?.format ?? null;
}

function parseDataUri(url: string): ResolvedImage | null {
  // data:[<mediatype>][;base64],<data>
  const [, mimeType, data] = url.match(/^data:([^;,]+)(?:;base64)?,(.+)$/s) ?? [];
  if (!mimeType || !data) return null;
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw mediaTooLargeError("Image", bytes.byteLength);
  }
  return { mimeType, bytes };
}

/** Fetch an external URL and return its bytes and mime type. */
async function fetchExternalImage(url: string): Promise<ResolvedImage | null> {
  try {
    const res = await safeFetch(url, { timeoutMs: FETCH_TIMEOUT_MS });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const [rawMimeType = ""] = contentType.split(";");
    const mimeType = rawMimeType.trim();

    const declaredSize = parseInt(res.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_MEDIA_BYTES) {
      throw mediaTooLargeError("Image", declaredSize);
    }

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_MEDIA_BYTES) {
      throw mediaTooLargeError("Image", buffer.byteLength);
    }

    return { mimeType, bytes: new Uint8Array(buffer) };
  } catch (err) {
    if (isMediaTooLarge(err)) {
      throw err;
    }
    return null;
  }
}

async function processImage(
  imageUrl: string,
  orgId: string,
  mediaStore: MediaStore | null,
  store: boolean,
): Promise<{ dataUri: string | null; dbUrl: string | null }> {
  const isDataUri = imageUrl.startsWith("data:");
  const resolved = isDataUri ? parseDataUri(imageUrl) : await fetchExternalImage(imageUrl);

  if (!resolved) {
    log.warn({ imageUrl: imageUrl.slice(0, 100) }, "Failed to resolve image, skipping");
    return { dataUri: null, dbUrl: null };
  }

  const { bytes } = resolved;
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    throw imageTypeUnsupportedError(resolved.mimeType);
  }
  const mimeType = isStorableImageType(resolved.mimeType) ? resolved.mimeType : sniffed;
  const dataUri = isDataUri
    ? imageUrl
    : `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;

  if (!store) {
    return { dataUri, dbUrl: null };
  }

  const originalUrl = isDataUri ? null : imageUrl;
  const dbUrl = await storeMedia(bytes, mimeType, originalUrl, orgId, mediaStore);
  return { dataUri, dbUrl: dbUrl ?? originalUrl };
}

async function processAudio(
  data: string,
  declaredFormat: string,
  orgId: string,
  mediaStore: MediaStore | null,
  store: boolean,
): Promise<string | null> {
  if (!isAudioFormat(declaredFormat)) {
    throw mediaPartInvalidError(
      `Audio format ${declaredFormat || "unknown"} is not supported. Supported: ${Object.keys(STORABLE_AUDIO_TYPES).join(", ")}`,
    );
  }
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw mediaTooLargeError("Audio", bytes.byteLength);
  }
  if (sniffAudioFormat(bytes) !== declaredFormat) {
    throw mediaPartInvalidError(`Audio data is not valid ${declaredFormat}`);
  }
  if (!store) {
    return null;
  }
  const mimeType: StorableAudioType = STORABLE_AUDIO_TYPES[declaredFormat];
  return storeMedia(bytes, mimeType, null, orgId, mediaStore);
}

/** The `xinity-media://` reference for the stored bytes, or null when storing failed. */
async function storeMedia(
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
  originalUrl: string | null,
  orgId: string,
  mediaStore: MediaStore | null,
): Promise<string | null> {
  try {
    const sha256 = bytesDigest(bytes);
    const s3Key = mediaStore ? `${orgId}/${sha256}` : null;

    // Upsert: if already stored by this org, reuse
    await getDB()
      .insert(mediaObjectT)
      .values({
        sha256,
        mimeType,
        originalUrl,
        s3Bucket: mediaStore?.bucket ?? null,
        s3Key,
        bytes: mediaStore ? null : bytes,
        organizationId: orgId,
        size: bytes.byteLength,
      })
      .onConflictDoNothing();

    if (mediaStore && s3Key) {
      // Idempotent: same key = same content, since the key is the digest
      await mediaStore.client.write(s3Key, bytes, { type: mimeType });
    }

    log.debug({ sha256, mimeType, size: bytes.byteLength, inS3: Boolean(mediaStore) }, "Media stored");
    return formatMediaRef(sha256);
  } catch (err) {
    log.error({ err, mimeType }, "Failed to store media");
    return null;
  }
}

const MAX_MEDIA_CONCURRENCY = 4;

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = Array<R>(items.length);
  let currentIndex = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      results[idx] = await fn(items[idx] as T, idx);
    }
  });
  await Promise.all(workers);
  return results;
}

type ProcessedPart = { llmPart: ApiCallInputMessageContent; dbPart: ApiCallInputMessageContent | null };

async function processPart(
  part: ApiCallInputMessageContent,
  orgId: string,
  mediaStore: MediaStore | null,
  store: boolean,
): Promise<ProcessedPart> {
  if (part.type === "image_url") {
    const url = part.image_url?.url;
    if (typeof url !== "string") {
      throw mediaPartInvalidError("image_url requires a url string");
    }
    const { dataUri, dbUrl } = await processImage(url, orgId, mediaStore, store);
    return {
      llmPart: dataUri ? { type: "image_url", image_url: { url: dataUri } } : part,
      dbPart: dbUrl !== null ? { type: "image_url", image_url: { url: dbUrl } } : null,
    };
  }
  if (part.type === "input_audio") {
    const { data, format } = part.input_audio ?? {};
    if (typeof data !== "string" || typeof format !== "string") {
      throw mediaPartInvalidError("input_audio requires a base64 data string and a format");
    }
    const dbRef = await processAudio(data, format, orgId, mediaStore, store);
    return {
      llmPart: part,
      dbPart: dbRef !== null ? { type: "input_audio", input_audio: { data: dbRef, format } } : null,
    };
  }
  return { llmPart: part, dbPart: part };
}

/**
 * `messagesForLLM` carries resolved media, `messagesForDB` carries references.
 *
 * `store` is `callWillBeLogged`: an unlogged call still needs its media for the model, but a
 * `media_object` written for it would be referenced by nothing, ever.
 */
export async function processMessageMedia(
  messages: ApiCallInputMessage[],
  orgId: string,
  mediaStore: MediaStore | null,
  store: boolean,
): Promise<{ messagesForLLM: ApiCallInputMessage[]; messagesForDB: ApiCallInputMessage[] }> {
  // Fast path: if no message has array content, skip processing
  const hasArrayContent = messages.some((m) => Array.isArray(m.content));
  if (!hasArrayContent) {
    return { messagesForLLM: messages, messagesForDB: messages };
  }

  const messagesForLLM: ApiCallInputMessage[] = [];
  const messagesForDB: ApiCallInputMessage[] = [];

  for (const [messageIndex, message] of messages.entries()) {
    if (typeof message.content === "string" || !Array.isArray(message.content)) {
      messagesForLLM.push(message);
      messagesForDB.push(message);
      continue;
    }

    // A serializer that failed to build a part writes null in its place, so point at where it was lost.
    const nullIndex = (message.content as unknown[]).indexOf(null);
    if (nullIndex !== -1) {
      throw mediaPartInvalidError(`messages[${messageIndex}].content[${nullIndex}] is null, expected a content part object`);
    }

    const processedParts = await mapConcurrent(
      message.content,
      MAX_MEDIA_CONCURRENCY,
      (part) => processPart(part, orgId, mediaStore, store),
    );

    const llmParts: ApiCallInputMessageContent[] = processedParts.map((p) => p.llmPart);
    const dbParts: ApiCallInputMessageContent[] = processedParts
      .map((p) => p.dbPart)
      .filter((p): p is ApiCallInputMessageContent => p !== null);

    messagesForLLM.push({ ...message, content: llmParts });

    if (dbParts.length > 0) {
      messagesForDB.push({ ...message, content: dbParts });
    }
    // If the message had only media and all of it was stripped, omit it from DB
  }

  return { messagesForLLM, messagesForDB };
}

/**
 * Reads a stored media object back out as a data URI. Logged messages keep `xinity-media://`
 * references instead of media data, so replaying one to a model means resolving it first.
 */
export async function resolveMediaRef(
  sha256: string,
  orgId: string,
  store: MediaStore | null,
): Promise<string | null> {
  const object = await readMediaObject(sha256, orgId, store);
  return object && `data:${object.mimeType};base64,${Buffer.from(object.bytes).toString("base64")}`;
}

async function readMediaObject(
  sha256: string,
  orgId: string,
  store: MediaStore | null,
): Promise<{ mimeType: string; bytes: Uint8Array } | null> {
  const [row] = await getDB()
    .select({ s3Key: mediaObjectT.s3Key, mimeType: mediaObjectT.mimeType, bytes: mediaObjectT.bytes })
    .from(mediaObjectT)
    .where(sql`${mediaObjectT.sha256} = ${sha256} AND ${mediaObjectT.organizationId} = ${orgId}`)
    .limit(1);
  if (!row) {
    return null;
  }
  try {
    const bytes = row.s3Key && store
      ? new Uint8Array(await store.client.file(row.s3Key).arrayBuffer())
      : row.bytes;
    if (!bytes) {
      return null;
    }
    return { mimeType: row.mimeType, bytes };
  } catch (err) {
    log.error({ err, sha256 }, "Failed to read a stored media object");
    return null;
  }
}

async function restoreMediaPart(
  part: ApiCallInputMessageContent,
  orgId: string,
  store: MediaStore | null,
): Promise<ApiCallInputMessageContent | null> {
  if (part.type === "image_url") {
    const sha256 = parseMediaRef(part.image_url.url);
    if (!sha256) {
      return part;
    }
    const dataUri = await resolveMediaRef(sha256, orgId, store);
    if (!dataUri) {
      log.warn({ sha256 }, "Dropping an image that could not be restored");
      return null;
    }
    return { type: "image_url", image_url: { url: dataUri } };
  }
  if (part.type === "input_audio") {
    const sha256 = parseMediaRef(part.input_audio.data);
    if (!sha256) {
      return part;
    }
    const object = await readMediaObject(sha256, orgId, store);
    if (!object) {
      log.warn({ sha256 }, "Dropping audio that could not be restored");
      return null;
    }
    const data = Buffer.from(object.bytes).toString("base64");
    return { type: "input_audio", input_audio: { data, format: part.input_audio.format } };
  }
  return part;
}

/**
 * A logged message with its media read back in. A part that cannot be restored is removed rather
 * than passed along, because a `xinity-media://` reference reaching a backend is a hard error
 * there, where a missing image or clip is only a gap.
 */
export async function restoreMediaParts(
  message: ApiCallInputMessage,
  orgId: string,
  store: MediaStore | null,
): Promise<ApiCallInputMessage> {
  if (!Array.isArray(message.content)) {
    return message;
  }
  const parts = (await Promise.all(
    message.content.map((part) => restoreMediaPart(part, orgId, store)),
  )).filter((part): part is ApiCallInputMessageContent => part !== null);
  return { ...message, content: parts };
}

/** Logged history made readable to a model again. A message left with no content gives the model nothing, so it goes. */
export async function restoreMessageMedia(
  messages: ApiCallInputMessage[],
  orgId: string,
  store: MediaStore | null,
): Promise<ApiCallInputMessage[]> {
  if (!messages.some((message) => Array.isArray(message.content))) {
    return messages;
  }
  const restored = await Promise.all(messages.map((message) => restoreMediaParts(message, orgId, store)));
  return restored.filter((message) => !Array.isArray(message.content) || message.content.length > 0);
}

// ─── Module-level singleton ──────────────────────────────────────────────────

/** Gateway-wide S3 media store. Null when object storage is not configured. */
export const mediaStore: MediaStore | null = createMediaStore(config.s3);
