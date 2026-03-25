/**
 * Multimodal image handling for the gateway.
 *
 * When S3 is configured, images embedded in chat requests are uploaded to
 * object storage before the call is forwarded. Inference nodes always receive
 * resolved data URIs; the database receives compact xinity-media:// references
 * that can be resolved by the dashboard.
 *
 * When S3 is not configured, external image URLs are still resolved to data
 * URIs for the inference node (they can't always reach arbitrary URLs), but
 * only the original URL is logged; inline data URIs are stripped from the
 * database log entirely.
 */
import type { S3Client } from "bun";
import { mediaObjectT, type ApiCallInputMessage, type ApiCallInputMessageContent } from "common-db";
import { rootLogger } from "./logger";
import { getDB } from "./db";
import { env } from "./env";

const log = rootLogger.child({ name: "image-store" });

export interface ImageStore {
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

/** Parse a data URI into its mime type and raw bytes. */
function parseDataUri(url: string): { mimeType: string; bytes: Uint8Array } | null {
  // data:[<mediatype>][;base64],<data>
  const match = url.match(/^data:([^;,]+)(?:;base64)?,(.+)$/s);
  if (!match) return null;
  const mimeType = match[1]!;
  const data = match[2]!;
  try {
    const bytes = Buffer.from(data, "base64");
    return { mimeType, bytes };
  } catch {
    return null;
  }
}

const MAX_IMAGE_BYTES = 40 * 1024 * 1024; 

/** Fetch an external URL and return its bytes and mime type. */
async function fetchExternalImage(url: string): Promise<{ mimeType: string; bytes: Uint8Array } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const mimeType = contentType.split(";")[0]!.trim();

    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_BYTES) {
      log.warn({ url: url.slice(0, 200), contentLength }, "Image exceeds size limit, skipping");
      return null;
    }

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      log.warn({ url: url.slice(0, 200), size: buffer.byteLength }, "Image exceeds size limit, skipping");
      return null;
    }

    return { mimeType, bytes: new Uint8Array(buffer) };
  } catch {
    return null;
  }
}

/** Compute SHA-256 hex digest of raw bytes using Bun's native hasher. */
function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
  };
  return map[mimeType] ?? "bin";
}

/**
 * Process a single image (data URI or external URL):
 * - Returns the data URI for the inference node (resolves external URLs).
 * - Uploads to S3 and returns the xinity-media:// reference for the DB,
 *   or the original external URL when S3 is unavailable, or null for
 *   data URIs when S3 is unavailable (they must be stripped).
 */
async function processImage(
  imageUrl: string,
  orgId: string,
  originalUrl: string | null,
  imageStore: ImageStore | null,
): Promise<{ dataUri: string | null; dbUrl: string | null }> {
  const isDataUri = imageUrl.startsWith("data:");

  // Resolve to bytes + mimeType
  let resolved: { mimeType: string; bytes: Uint8Array } | null;
  if (isDataUri) {
    resolved = parseDataUri(imageUrl);
  } else {
    resolved = await fetchExternalImage(imageUrl);
  }

  if (!resolved) {
    log.warn({ imageUrl: imageUrl.slice(0, 100) }, "Failed to resolve image, skipping");
    return { dataUri: null, dbUrl: null };
  }

  const { mimeType, bytes } = resolved;

  // Build data URI for the inference node
  const dataUri = isDataUri
    ? imageUrl
    : `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;

  if (!imageStore) {
    // S3 disabled: log original external URL, strip data URIs
    const dbUrl = isDataUri ? null : (originalUrl ?? imageUrl);
    return { dataUri, dbUrl };
  }

  // S3 enabled: upload and create media_object record
  try {
    const sha256 = sha256Hex(bytes);
    const s3Key = `${orgId}/${sha256}`;
    const ext = mimeToExtension(mimeType);

    // Upsert: if already uploaded by this org, reuse
    await getDB()
      .insert(mediaObjectT)
      .values({
        sha256,
        mimeType,
        originalUrl: isDataUri ? null : (originalUrl ?? imageUrl),
        s3Bucket: imageStore.bucket,
        s3Key,
        organizationId: orgId,
        size: bytes.byteLength,
      })
      .onConflictDoNothing();

    // Upload to S3 (idempotent: same key = same content due to SHA-256)
    await imageStore.client.write(s3Key, bytes, { type: mimeType });

    log.debug({ sha256, size: bytes.byteLength, ext }, "Image stored in S3");
    return { dataUri, dbUrl: `xinity-media://${sha256}` };
  } catch (err) {
    log.error({ err }, "Failed to store image in S3, falling back to original URL");
    // Fallback: for data URIs we can't store inline, omit from DB
    const dbUrl = isDataUri ? null : (originalUrl ?? imageUrl);
    return { dataUri, dbUrl };
  }
}

/**
 * Transform messages containing image_url content parts:
 * - messagesForLLM: all images resolved to data URIs (inference node ready)
 * - messagesForDB: images replaced with xinity-media:// references, or
 *   original external URLs when S3 is disabled, data URIs stripped entirely
 */
export async function processMessageImages(
  messages: ApiCallInputMessage[],
  orgId: string,
  imageStore: ImageStore | null,
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

    const llmParts: ApiCallInputMessageContent[] = [];
    const dbParts: ApiCallInputMessageContent[] = [];

    for (const part of message.content) {
      if (part.type !== "image_url") {
        llmParts.push(part);
        dbParts.push(part);
        continue;
      }

      const imageUrl = part.image_url.url;
      const { dataUri, dbUrl } = await processImage(
        imageUrl,
        orgId,
        imageUrl.startsWith("data:") ? null : imageUrl,
        imageStore,
      );

      if (dataUri) {
        llmParts.push({ type: "image_url", image_url: { url: dataUri } });
      } else {
        // Could not resolve image, pass original to LLM, omit from DB
        llmParts.push(part);
      }

      if (dbUrl !== null) {
        dbParts.push({ type: "image_url", image_url: { url: dbUrl } });
      }
      // If dbUrl is null (data URI with no S3), the image is omitted from DB
    }

    messagesForLLM.push({ ...message, content: llmParts });

    if (dbParts.length > 0) {
      messagesForDB.push({ ...message, content: dbParts });
    }
    // If the message had only images and all were stripped, omit it from DB
  }

  return { messagesForLLM, messagesForDB };
}

/**
 * Parse a xinity-media:// URL and return the SHA-256 hash.
 * Returns null if the URL is not a xinity-media:// reference.
 */
export function parseMediaRef(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "xinity-media:") return null;
  return parsed.hostname;
}

// ─── Module-level singleton ──────────────────────────────────────────────────

/** Gateway-wide S3 image store. Null when S3 env vars are not configured. */
export const imageStore: ImageStore | null = createImageStore(env);
