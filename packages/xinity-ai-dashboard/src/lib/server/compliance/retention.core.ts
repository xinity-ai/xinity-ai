/**
 * Pure data-retention purge logic, with all side-effecting dependencies
 * (database handle, S3 blob deletion, logging) injected. This keeps the
 * logic that irreversibly deletes customer data unit-testable against a
 * real database without the SvelteKit server environment. The scheduler
 * wiring lives in retention.service.ts.
 */
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
  type preconfigureDB,
  retentionPolicyT,
  retentionRunT,
  type RetentionPolicy,
} from "common-db";

export type RetentionDb = ReturnType<ReturnType<typeof preconfigureDB>["getDB"]>;

/** Deletes a blob from object storage; returns false on failure or when S3 is unconfigured. */
export type DeleteBlob = (s3Key: string) => Promise<boolean>;

export type RetentionLogger = {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

const NOOP_LOGGER: RetentionLogger = { info: () => {}, error: () => {} };

/** Slightly under 24h so hourly check jitter cannot skip a day. */
export const MIN_PURGE_INTERVAL_MS = 23 * 60 * 60_000;
/** apiCall rows can number in the millions; never delete in one statement. */
export const DELETE_BATCH_SIZE = 5000;

export function cutoffDate(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60_000);
}

/**
 * Purge is tracked via the newest retentionRun row instead of in-memory
 * state so restarts neither double-run nor never-run an organization.
 */
export async function isPurgeDue(db: RetentionDb, organizationId: string, now: Date): Promise<boolean> {
  const [lastRun] = await db
    .select({ startedAt: retentionRunT.startedAt })
    .from(retentionRunT)
    .where(eq(retentionRunT.organizationId, organizationId))
    .orderBy(desc(retentionRunT.startedAt))
    .limit(1);
  return !lastRun || now.getTime() - lastRun.startedAt.getTime() >= MIN_PURGE_INTERVAL_MS;
}

export async function purgeApiCalls(db: RetentionDb, organizationId: string, cutoff: Date): Promise<number> {
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
export async function purgeMediaObjects(
  db: RetentionDb,
  organizationId: string,
  cutoff: Date,
  deleteBlob: DeleteBlob,
  errors: string[],
): Promise<number> {
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
    if (await deleteBlob(row.s3Key)) {
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

export async function purgeOrganization(
  db: RetentionDb,
  policy: RetentionPolicy,
  now: Date,
  deleteBlob: DeleteBlob,
  log: RetentionLogger = NOOP_LOGGER,
): Promise<void> {
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
      deletedApiCalls = await purgeApiCalls(db, policy.organizationId, apiCallCutoff);
    }
    if (mediaCutoff) {
      deletedMediaObjects = await purgeMediaObjects(db, policy.organizationId, mediaCutoff, deleteBlob, errors);
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

export async function runRetentionCycle(
  db: RetentionDb,
  now: Date,
  deleteBlob: DeleteBlob,
  log: RetentionLogger = NOOP_LOGGER,
): Promise<void> {
  const policies = await db
    .select()
    .from(retentionPolicyT)
    .where(or(
      isNotNull(retentionPolicyT.apiCallRetentionDays),
      isNotNull(retentionPolicyT.mediaRetentionDays),
    ));

  for (const policy of policies) {
    try {
      if (await isPurgeDue(db, policy.organizationId, now)) {
        await purgeOrganization(db, policy, now, deleteBlob, log);
      }
    } catch (err) {
      log.error({ err, organizationId: policy.organizationId }, "Retention cycle failed for organization");
    }
  }
}
