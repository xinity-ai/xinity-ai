/**
 * Multimodal image handling. Inference nodes always receive resolved data URIs, and the
 * database always receives a `xinity-media://` reference, whether the bytes went to S3 or
 * into `media_object` itself.
 */
import type { S3Client } from "bun";
import { mediaObjectT, sql, type ApiCallInputMessage, type ApiCallInputMessageContent } from "common-db";
import { bytesDigest } from "common-env";
import { formatMediaRef, parseMediaRef } from "common-env/media-ref";
import { rootLogger } from "./logger";
import { getDB } from "./db";
import { env } from "./env";
import { safeFetch } from "./llm-forward/tools/url-safety";

const log = rootLogger.child({ name: "image-store" });

export type ImageStore = {
  client: S3Client;
  bucket: string;
}

/** Create an ImageStore from config, or return null if S3 is not configured. */
export function createImageStore(config: {
  S3_ENDPOINT?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_BUCKET: string;
  S3_REGION: string;
}): ImageStore | null {
  if (!config.S3_ENDPOINT || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY) {
    return null;
  }
  return {
    client: new Bun.S3Client({
      endpoint: config.S3_ENDPOINT,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      bucket: config.S3_BUCKET,
      region: config.S3_REGION,
    }),
    bucket: config.S3_BUCKET,
  };
}

type ResolvedImage = { mimeType: string; bytes: Uint8Array<ArrayBuffer> };

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const IMAGE_TOO_LARGE = "image_too_large";

/** Rejected rather than dropped: a picture missing from the log is missing from the
 * conversation every later turn replays. */
function imageTooLargeError(size: number): Error {
  const limitMb = Math.floor(MAX_IMAGE_BYTES / (1024 * 1024));
  return Object.assign(
    new Error(`Image is ${size} bytes, over the ${limitMb}MB limit`),
    { code: IMAGE_TOO_LARGE },
  );
}

export function isImageTooLarge(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === IMAGE_TOO_LARGE;
}

function parseDataUri(url: string): ResolvedImage | null {
  // data:[<mediatype>][;base64],<data>
  const [, mimeType, data] = url.match(/^data:([^;,]+)(?:;base64)?,(.+)$/s) ?? [];
  if (!mimeType || !data) return null;
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw imageTooLargeError(bytes.byteLength);
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
    if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) {
      throw imageTooLargeError(declaredSize);
    }

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw imageTooLargeError(buffer.byteLength);
    }

    return { mimeType, bytes: new Uint8Array(buffer) };
  } catch (err) {
    if (isImageTooLarge(err)) {
      throw err;
    }
    return null;
  }
}

async function processImage(
  imageUrl: string,
  orgId: string,
  imageStore: ImageStore | null,
  store: boolean,
): Promise<{ dataUri: string | null; dbUrl: string | null }> {
  const isDataUri = imageUrl.startsWith("data:");
  const resolved = isDataUri ? parseDataUri(imageUrl) : await fetchExternalImage(imageUrl);

  if (!resolved) {
    log.warn({ imageUrl: imageUrl.slice(0, 100) }, "Failed to resolve image, skipping");
    return { dataUri: null, dbUrl: null };
  }

  const { mimeType, bytes } = resolved;
  const dataUri = isDataUri
    ? imageUrl
    : `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;

  if (!store) {
    return { dataUri, dbUrl: null };
  }

  const originalUrl = isDataUri ? null : imageUrl;

  try {
    const sha256 = bytesDigest(bytes);
    const s3Key = imageStore ? `${orgId}/${sha256}` : null;

    // Upsert: if already stored by this org, reuse
    await getDB()
      .insert(mediaObjectT)
      .values({
        sha256,
        mimeType,
        originalUrl,
        s3Bucket: imageStore?.bucket ?? null,
        s3Key,
        bytes: imageStore ? null : bytes,
        organizationId: orgId,
        size: bytes.byteLength,
      })
      .onConflictDoNothing();

    if (imageStore && s3Key) {
      // Idempotent: same key = same content, since the key is the digest
      await imageStore.client.write(s3Key, bytes, { type: mimeType });
    }

    log.debug({ sha256, size: bytes.byteLength, inS3: Boolean(imageStore) }, "Image stored");
    return { dataUri, dbUrl: formatMediaRef(sha256) };
  } catch (err) {
    log.error({ err }, "Failed to store image, falling back to the original URL");
    return { dataUri, dbUrl: originalUrl };
  }
}

const MAX_IMAGE_CONCURRENCY = 4;

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

/**
 * `messagesForLLM` carries resolved data URIs, `messagesForDB` carries references.
 *
 * `store` is `callWillBeLogged`: an unlogged call still needs its data URIs for the model, but a
 * `media_object` written for it would be referenced by nothing, ever.
 */
export async function processMessageImages(
  messages: ApiCallInputMessage[],
  orgId: string,
  imageStore: ImageStore | null,
  store: boolean,
): Promise<{ messagesForLLM: ApiCallInputMessage[]; messagesForDB: ApiCallInputMessage[] }> {
  // Fast path: if no message has array content, skip processing
  const hasArrayContent = messages.some((m) => Array.isArray(m.content));
  if (!hasArrayContent) {
    return { messagesForLLM: messages, messagesForDB: messages };
  }

  const messagesForLLM: ApiCallInputMessage[] = [];
  const messagesForDB: ApiCallInputMessage[] = [];

  for (const message of messages) {
    if (typeof message.content === "string" || !Array.isArray(message.content)) {
      messagesForLLM.push(message);
      messagesForDB.push(message);
      continue;
    }

    const processedParts = await mapConcurrent(
      message.content,
      MAX_IMAGE_CONCURRENCY,
      async (part) => {
        if (part.type !== "image_url") {
          return { llmPart: part, dbPart: part as ApiCallInputMessageContent | null };
        }

        const imageUrl = part.image_url.url;
        const { dataUri, dbUrl } = await processImage(imageUrl, orgId, imageStore, store);

        const llmPart: ApiCallInputMessageContent = dataUri
          ? { type: "image_url", image_url: { url: dataUri } }
          : part;

        const dbPart: ApiCallInputMessageContent | null = dbUrl !== null
          ? { type: "image_url", image_url: { url: dbUrl } }
          : null;

        return { llmPart, dbPart };
      },
    );

    const llmParts: ApiCallInputMessageContent[] = processedParts.map((p) => p.llmPart);
    const dbParts: ApiCallInputMessageContent[] = processedParts
      .map((p) => p.dbPart)
      .filter((p): p is ApiCallInputMessageContent => p !== null);

    messagesForLLM.push({ ...message, content: llmParts });

    if (dbParts.length > 0) {
      messagesForDB.push({ ...message, content: dbParts });
    }
    // If the message had only images and all were stripped, omit it from DB
  }

  return { messagesForLLM, messagesForDB };
}

/**
 * Reads a stored image back out as a data URI. Logged messages keep `xinity-media://` references
 * instead of image data, so replaying one to a model means resolving it first.
 */
export async function resolveMediaRef(
  sha256: string,
  orgId: string,
  store: ImageStore | null,
): Promise<string | null> {
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
    return `data:${row.mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch (err) {
    log.error({ err, sha256 }, "Failed to read a stored image");
    return null;
  }
}

async function restoreImagePart(
  part: ApiCallInputMessageContent,
  orgId: string,
  store: ImageStore | null,
): Promise<ApiCallInputMessageContent | null> {
  if (part.type !== "image_url") {
    return part;
  }
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

/**
 * Turns logged messages back into something a model can read. An image that cannot be restored
 * is dropped rather than passed along, because a `xinity-media://` url reaching a backend is a
 * hard error there, where a missing image is only a gap.
 */
export async function restoreMessageImages(
  messages: ApiCallInputMessage[],
  orgId: string,
  store: ImageStore | null,
): Promise<ApiCallInputMessage[]> {
  if (!messages.some((message) => Array.isArray(message.content))) {
    return messages;
  }

  const restored: ApiCallInputMessage[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      restored.push(message);
      continue;
    }
    const parts = (await Promise.all(
      message.content.map((part) => restoreImagePart(part, orgId, store)),
    )).filter((part): part is ApiCallInputMessageContent => part !== null);
    if (parts.length > 0) {
      restored.push({ ...message, content: parts });
    }
  }
  return restored;
}

// ─── Module-level singleton ──────────────────────────────────────────────────

/** Gateway-wide S3 image store. Null when S3 env vars are not configured. */
export const imageStore: ImageStore | null = createImageStore(env);
