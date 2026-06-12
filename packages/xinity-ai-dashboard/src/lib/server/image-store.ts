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
import { mediaObjectT, and, eq } from "common-db";
import { getDB } from "./db";
import { rootLogger } from "./logging";

const log = rootLogger.child({ name: "image-store" });

/** Presigned URL TTL in seconds: 15 minutes is enough for one page view. */
const PRESIGN_TTL_SECONDS = 900;

// ─── S3 client singleton ─────────────────────────────────────────────────────

let _client: S3Client | null = null;

function getClient(): S3Client | null {
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

type MediaObjectRow = { s3Key: string; mimeType: string };

async function findMediaObject(
  sha256: string,
  organizationId: string,
): Promise<MediaObjectRow | null> {
  const [row] = await getDB()
    .select({ s3Key: mediaObjectT.s3Key, mimeType: mediaObjectT.mimeType })
    .from(mediaObjectT)
    .where(and(
      eq(mediaObjectT.sha256, sha256),
      eq(mediaObjectT.organizationId, organizationId),
    ))
    .limit(1);
  return row ?? null;
}

async function withMediaObject<T>(
  sha256: string,
  organizationId: string,
  operation: (client: S3Client, row: MediaObjectRow) => Promise<T> | T,
  errorMessage: string,
): Promise<T | null> {
  const client = getClient();
  if (!client) return null;

  const row = await findMediaObject(sha256, organizationId);
  if (!row) return null;

  try {
    return await operation(client, row);
  } catch (err) {
    log.error({ err, sha256 }, errorMessage);
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a short-lived presigned GET URL for a media object identified
 * by its SHA-256 hash and the owning organization.
 *
 * Returns null when S3 is not configured or the object is not found.
 */
export function getPresignedUrl(
  sha256: string,
  organizationId: string,
): Promise<string | null> {
  return withMediaObject(
    sha256,
    organizationId,
    (client, row) => client.presign(row.s3Key, { expiresIn: PRESIGN_TTL_SECONDS }),
    "Failed to generate presigned URL",
  );
}

/**
 * Resolve a xinity-media:// URL to a base64 data URI.
 * Used when generating self-contained download exports.
 *
 * Returns null when S3 is not configured, the object is not found,
 * or download fails.
 */
export function resolveToDataUri(
  sha256: string,
  organizationId: string,
): Promise<string | null> {
  return withMediaObject(
    sha256,
    organizationId,
    async (client, row) => {
      const buffer = await client.file(row.s3Key).arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      return `data:${row.mimeType};base64,${base64}`;
    },
    "Failed to download image from S3",
  );
}

/**
 * Delete a media object's blob from S3 by its key.
 * Returns false when S3 is not configured or deletion fails, so callers
 * can keep the database row and avoid orphaning blobs.
 */
export async function deleteS3Object(s3Key: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  try {
    await client.delete(s3Key);
    return true;
  } catch (err) {
    log.error({ err, s3Key }, "Failed to delete S3 object");
    return false;
  }
}

/** Parse a xinity-media:// URL and return its SHA-256 hash, or null. */
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
