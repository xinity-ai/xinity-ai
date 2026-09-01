/**
 * Dashboard-side S3 image store utilities.
 *
 * Generates presigned URLs for in-browser display and resolves
 * xinity-media:// references to data URIs for self-contained exports.
 * Presigned URL generation must only happen server-side (credentials
 * must never be exposed to the browser).
 */
import type { S3Client } from "bun";
import { serverEnv } from "./serverenv";
import { mediaObjectT, sql } from "common-db";
import { getDB } from "./db";
import { rootLogger } from "./logging";

const log = rootLogger.child({ name: "image-store" });

/** Presigned URL TTL in seconds: 15 minutes is enough for one page view. */
const PRESIGN_TTL_SECONDS = 900;

// ─── S3 client singleton ─────────────────────────────────────────────────────

let _client: S3Client | null = null;

export function mediaS3Client(): S3Client | null {
  if (_client !== null) return _client;
  if (!serverEnv.S3_ENDPOINT || !serverEnv.S3_ACCESS_KEY_ID || !serverEnv.S3_SECRET_ACCESS_KEY) return null;
  _client = new Bun.S3Client({
    endpoint: serverEnv.S3_ENDPOINT,
    accessKeyId: serverEnv.S3_ACCESS_KEY_ID,
    secretAccessKey: serverEnv.S3_SECRET_ACCESS_KEY,
    bucket: serverEnv.S3_BUCKET,
    region: serverEnv.S3_REGION,
  });
  return _client;
}

type MediaObjectRow = { s3Key: string | null; mimeType: string; bytes: Uint8Array<ArrayBuffer> | null };

async function findMediaObject(
  sha256: string,
  organizationId: string,
): Promise<MediaObjectRow | null> {
  const [row] = await getDB()
    .select({ s3Key: mediaObjectT.s3Key, mimeType: mediaObjectT.mimeType, bytes: mediaObjectT.bytes })
    .from(mediaObjectT)
    .where(sql`
      ${mediaObjectT.sha256} = ${sha256}
    AND
      ${mediaObjectT.organizationId} = ${organizationId}
    `)
    .limit(1);
  return row ?? null;
}

/** Null for an object the database holds itself, which no client can read. */
async function readObject(row: MediaObjectRow): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!row.s3Key) {
    return row.bytes;
  }
  const client = mediaS3Client();
  if (!client) {
    return null;
  }
  return new Uint8Array(await client.file(row.s3Key).arrayBuffer());
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a short-lived presigned GET URL for a media object identified
 * by its SHA-256 hash and the owning organization.
 *
 * Returns null when S3 is not configured or the object is not found.
 */
export async function getPresignedUrl(
  sha256: string,
  organizationId: string,
): Promise<string | null> {
  const client = mediaS3Client();
  if (!client) {
    return null;
  }
  const row = await findMediaObject(sha256, organizationId);
  // Nothing to presign for an object the database holds: the caller serves it instead.
  if (!row?.s3Key) {
    return null;
  }
  try {
    return client.presign(row.s3Key, { expiresIn: PRESIGN_TTL_SECONDS });
  } catch (err) {
    log.error({ err, sha256 }, "Failed to generate presigned URL");
    return null;
  }
}

/** The bytes behind a reference, from S3 or from the database, whichever holds them. */
export async function readMediaObject(
  sha256: string,
  organizationId: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string } | null> {
  const row = await findMediaObject(sha256, organizationId);
  if (!row) {
    return null;
  }
  try {
    const bytes = await readObject(row);
    return bytes ? { bytes, mimeType: row.mimeType } : null;
  } catch (err) {
    log.error({ err, sha256 }, "Failed to read the stored image");
    return null;
  }
}

/**
 * Resolve a xinity-media:// URL to a base64 data URI.
 * Used when generating self-contained download exports.
 */
export async function resolveToDataUri(
  sha256: string,
  organizationId: string,
): Promise<string | null> {
  const object = await readMediaObject(sha256, organizationId);
  if (!object) {
    return null;
  }
  return `data:${object.mimeType};base64,${Buffer.from(object.bytes).toString("base64")}`;
}
