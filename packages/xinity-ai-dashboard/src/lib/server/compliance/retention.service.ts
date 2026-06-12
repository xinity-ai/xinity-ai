import {
  and,
  apiCallT,
  auditLogT,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  mediaObjectT,
  or,
  retentionPolicyT,
  retentionRunT,
  type RetentionPolicy,
} from "common-db";
import { building } from "$app/environment";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { deleteS3Object } from "$lib/server/image-store";

const log = rootLogger.child({ name: "retention.service" });

const WARMUP_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 60 * 60_000; // hourly
/** Slightly under 24h so hourly check jitter cannot skip a day. */
const MIN_PURGE_INTERVAL_MS = 23 * 60 * 60_000;
/** apiCall rows can number in the millions; never delete in one statement. */
const DELETE_BATCH_SIZE = 5000;

function cutoffDate(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60_000);
}

/**
 * Purge is tracked via the newest retentionRun row instead of in-memory
 * state so restarts neither double-run nor never-run an organization.
 */
async function isPurgeDue(organizationId: string, now: Date): Promise<boolean> {
  const [lastRun] = await getDB()
    .select({ startedAt: retentionRunT.startedAt })
    .from(retentionRunT)
    .where(eq(retentionRunT.organizationId, organizationId))
    .orderBy(desc(retentionRunT.startedAt))
    .limit(1);
  return !lastRun || now.getTime() - lastRun.startedAt.getTime() >= MIN_PURGE_INTERVAL_MS;
}

async function purgeApiCalls(organizationId: string, cutoff: Date): Promise<number> {
  const db = getDB();
  let deleted = 0;
  while (true) {
    const batch = await db
      .delete(apiCallT)
      .where(inArray(
        apiCallT.id,
        db.select({ id: apiCallT.id })
          .from(apiCallT)
          .where(and(
            eq(apiCallT.organizationId, organizationId),
            lt(apiCallT.createdAt, cutoff),
          ))
          .limit(DELETE_BATCH_SIZE),
      ))
      .returning({ id: apiCallT.id });
    deleted += batch.length;
    if (batch.length < DELETE_BATCH_SIZE) break;
  }
  return deleted;
}

/**
 * Deletes the S3 blob first and only then the row; on S3 failure the row is
 * kept so no blob is orphaned. Filters on updatedAt rather than createdAt so
 * deduplicated images that were re-uploaded recently survive.
 */
async function purgeMediaObjects(
  organizationId: string,
  cutoff: Date,
  errors: string[],
): Promise<number> {
  const db = getDB();
  const expired = await db
    .select({ id: mediaObjectT.id, s3Key: mediaObjectT.s3Key })
    .from(mediaObjectT)
    .where(and(
      eq(mediaObjectT.organizationId, organizationId),
      lt(mediaObjectT.updatedAt, cutoff),
    ));

  let deleted = 0;
  let s3Failures = 0;
  for (const row of expired) {
    if (await deleteS3Object(row.s3Key)) {
      await db.delete(mediaObjectT).where(eq(mediaObjectT.id, row.id));
      deleted++;
    } else {
      s3Failures++;
    }
  }
  if (s3Failures > 0) {
    errors.push(`${s3Failures} media object(s) kept: S3 deletion failed or S3 is not configured`);
  }
  return deleted;
}

async function purgeOrganization(policy: RetentionPolicy, now: Date): Promise<void> {
  const db = getDB();
  const apiCallCutoff = policy.apiCallRetentionDays !== null
    ? cutoffDate(now, policy.apiCallRetentionDays)
    : null;
  const mediaDays = policy.mediaRetentionDays ?? policy.apiCallRetentionDays;
  const mediaCutoff = mediaDays !== null ? cutoffDate(now, mediaDays) : null;

  const [run] = await db
    .insert(retentionRunT)
    .values({
      organizationId: policy.organizationId,
      startedAt: now,
      apiCallCutoff,
      mediaCutoff,
    })
    .returning({ id: retentionRunT.id });

  let deletedApiCalls = 0;
  let deletedMediaObjects = 0;
  const errors: string[] = [];
  try {
    if (apiCallCutoff) {
      deletedApiCalls = await purgeApiCalls(policy.organizationId, apiCallCutoff);
    }
    if (mediaCutoff) {
      deletedMediaObjects = await purgeMediaObjects(policy.organizationId, mediaCutoff, errors);
    }
  } catch (err) {
    log.error({ err, organizationId: policy.organizationId }, "Retention purge failed");
    errors.push(err instanceof Error ? err.message : String(err));
  }

  await db
    .update(retentionRunT)
    .set({
      finishedAt: new Date(),
      deletedApiCalls,
      deletedMediaObjects,
      error: errors.length > 0 ? errors.join("; ") : null,
    })
    .where(eq(retentionRunT.id, run.id));

  if (deletedApiCalls > 0 || deletedMediaObjects > 0 || errors.length > 0) {
    // System actor (null user): scheduled purge, not a user action.
    await db.insert(auditLogT).values({
      organizationId: policy.organizationId,
      action: "retention.purge",
      resourceType: "retentionRun",
      resourceId: run.id,
      details: { deletedApiCalls, deletedMediaObjects, errors },
    });
    log.info(
      { organizationId: policy.organizationId, deletedApiCalls, deletedMediaObjects, errors },
      "Retention purge completed",
    );
  }
}

async function runRetentionCycle(): Promise<void> {
  const now = new Date();
  const policies = await getDB()
    .select()
    .from(retentionPolicyT)
    .where(or(
      isNotNull(retentionPolicyT.apiCallRetentionDays),
      isNotNull(retentionPolicyT.mediaRetentionDays),
    ));

  for (const policy of policies) {
    try {
      if (await isPurgeDue(policy.organizationId, now)) {
        await purgeOrganization(policy, now);
      }
    } catch (err) {
      log.error({ err, organizationId: policy.organizationId }, "Retention cycle failed for organization");
    }
  }
}

/**
 * Start the retention purge service. Checks hourly; purges each organization
 * with a configured policy at most once per day.
 */
export function startRetentionService(): void {
  if (building) return;
  log.info("Starting retention service");
  setTimeout(() => {
    void runRetentionCycle().catch((err: unknown) => log.error({ err }, "Retention cycle failed"));
    setInterval(() => {
      void runRetentionCycle().catch((err: unknown) => log.error({ err }, "Retention cycle failed"));
    }, CHECK_INTERVAL_MS);
  }, WARMUP_DELAY_MS);
}
