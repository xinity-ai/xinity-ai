/**
 * Dashboard-side S3 image store utilities.
 *
 * Generates presigned URLs for in-browser display and resolves
 * xinity-media:// references to data URIs for self-contained exports.
 * Presigned URL generation must only happen server-side (credentials
 * must never be exposed to the browser).
 */
import type { S3Client } from "bun";
import { serverEnv } from "./serverenv.ts";
import { mediaObjectT, sql } from "common-db";
import { getDB } from "./db.ts";
import { rootLogger } from "./logging.ts";

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

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Whether S3 is configured in the dashboard environment.
 * When false, xinity-media:// references cannot be resolved.
 */
export const isS3Configured = (): boolean => getClient() !== null;

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
  const client = getClient();
  if (!client) return null;

  const [row] = await getDB()
    .select({ s3Key: mediaObjectT.s3Key })
    .from(mediaObjectT)
    .where(sql`${mediaObjectT.sha256} = ${sha256} AND ${mediaObjectT.organizationId} = ${organizationId}`)
    .limit(1);

  if (!row) return null;

  try {
    return client.presign(row.s3Key, { expiresIn: PRESIGN_TTL_SECONDS });
  } catch (err) {
    log.error({ err, sha256 }, "Failed to generate presigned URL");
    return null;
  }
}

/**
 * Resolve a xinity-media:// URL to a base64 data URI.
 * Used when generating self-contained download exports.
 *
 * Returns null when S3 is not configured, the object is not found,
 * or download fails.
 */
export async function resolveToDataUri(
  sha256: string,
  organizationId: string,
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  const [row] = await getDB()
    .select({ s3Key: mediaObjectT.s3Key, mimeType: mediaObjectT.mimeType })
    .from(mediaObjectT)
    .where(sql`${mediaObjectT.sha256} = ${sha256} AND ${mediaObjectT.organizationId} = ${organizationId}`)
    .limit(1);

  if (!row) return null;

  try {
    const buffer = await client.file(row.s3Key).arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return `data:${row.mimeType};base64,${base64}`;
  } catch (err) {
    log.error({ err, sha256 }, "Failed to download image from S3");
    return null;
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
