/**
 * Moves media the database is carrying itself into S3. `media_object` holds image bytes directly
 * when no bucket is configured, so an operator who configures one later is left with rows the
 * database has no reason to keep.
 */
import { mediaObjectT, sql, count } from "common-db";
import { serverEnv } from "../serverenv";
import { getDB } from "../db";
import { mediaS3Client } from "../image-store";
import { rootLogger } from "../logging";

const log = rootLogger.child({ name: "media-migration" });

export type MediaMoveProgress = {
  moved: number;
  failed: number;
  remaining: number;
};

export async function countDatabaseBackedMedia(): Promise<number> {
  const [row] = await getDB()
    .select({ count: count() })
    .from(mediaObjectT)
    .where(sql`${mediaObjectT.bytes} IS NOT NULL`);
  return row?.count ?? 0;
}

const mediaKey = (organizationId: string, sha256: string) => `${organizationId}/${sha256}`;

/**
 * S3 is outside the transaction, so the upload has to land before the row stops carrying the only
 * copy. A row updated after a failed upload would lose the image outright; an upload followed by a
 * failed update just leaves an unreferenced object that the next run overwrites, since the key is
 * the digest.
 */
export async function moveMediaToS3(chunkSize: number): Promise<MediaMoveProgress> {
  const client = mediaS3Client();
  if (!client) {
    throw new Error("S3 is not configured");
  }

  const rows = await getDB()
    .select({
      id: mediaObjectT.id,
      organizationId: mediaObjectT.organizationId,
      sha256: mediaObjectT.sha256,
      mimeType: mediaObjectT.mimeType,
      bytes: mediaObjectT.bytes,
    })
    .from(mediaObjectT)
    .where(sql`${mediaObjectT.bytes} IS NOT NULL`)
    .limit(chunkSize);

  let moved = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.bytes) {
      continue;
    }
    const key = mediaKey(row.organizationId, row.sha256);
    await client.write(key, row.bytes, { type: row.mimeType })
      .then(() => getDB()
        .update(mediaObjectT)
        .set({ s3Bucket: serverEnv.S3_BUCKET, s3Key: key, bytes: null })
        .where(sql`${mediaObjectT.id} = ${row.id}`))
      .then(() => { moved += 1; })
      .catch((err) => {
        failed += 1;
        log.error({ err, mediaObjectId: row.id }, "Media move to S3 failed");
      });
  }

  return { moved, failed, remaining: await countDatabaseBackedMedia() };
}
