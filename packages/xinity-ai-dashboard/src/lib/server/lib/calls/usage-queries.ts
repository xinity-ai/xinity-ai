/**
 * Usage queries over usage_event and usage_summary. Failed calls are excluded from call counts.
 * Their tokens are included in token sums, because the backend produced those tokens.
 *
 * This module imports only from common-db, so the system tests can import it.
 */
import { sql, usageEventT, NIL_APP_UUID, type preconfigureDB } from "common-db";

type DB = ReturnType<ReturnType<typeof preconfigureDB>["getDB"]>;

/**
 * Moves usageEvent rows older than 30 days into usageSummary. One statement, so overlapping
 * runs cannot both move the same rows. A group of only failed rows still gets a summary row,
 * with 0 calls and its tokens.
 */
export async function rollupUsageEvents(db: DB, orgId: string) {
  await db.execute(sql`
    WITH moved AS (
      DELETE FROM "call_data"."usage_event"
      WHERE "organization_id" = ${orgId} AND "created_at" < CURRENT_DATE - INTERVAL '30 days'
      RETURNING *
    )
    INSERT INTO "call_data"."usage_summary"
      ("date", "organization_id", "application_id", "api_key_id", "model",
       "total_calls", "logged_calls", "input_tokens", "output_tokens", "total_duration")
    SELECT
      DATE("created_at"), "organization_id", COALESCE("application_id", ${NIL_APP_UUID}::uuid), "api_key_id", "model",
      COUNT(*) FILTER (WHERE "success")::int,
      COUNT(*) FILTER (WHERE "success" AND "logged")::int,
      COALESCE(SUM("input_tokens"), 0),
      COALESCE(SUM("output_tokens"), 0),
      COALESCE(SUM("duration") FILTER (WHERE "success"), 0)
    FROM moved
    GROUP BY DATE("created_at"), "organization_id", "application_id", "api_key_id", "model"
    ON CONFLICT ("date", "organization_id", "application_id", "api_key_id", "model")
    DO UPDATE SET
      "total_calls" = "usage_summary"."total_calls" + EXCLUDED."total_calls",
      "logged_calls" = "usage_summary"."logged_calls" + EXCLUDED."logged_calls",
      "input_tokens" = "usage_summary"."input_tokens" + EXCLUDED."input_tokens",
      "output_tokens" = "usage_summary"."output_tokens" + EXCLUDED."output_tokens",
      "total_duration" = "usage_summary"."total_duration" + EXCLUDED."total_duration"
  `);
}

/** Calls and tokens per day for the last 30 days. Days without calls are absent. */
export function dailyUsage(db: DB, orgId: string) {
  return db.select({
    date: sql<string>`to_char(DATE(${usageEventT.createdAt}), 'YYYY-MM-DD')`,
    totalCalls: sql<number>`COUNT(*) FILTER (WHERE ${usageEventT.success})::int`,
    loggedCalls: sql<number>`COUNT(*) FILTER (WHERE ${usageEventT.success} AND ${usageEventT.logged})::int`,
    inputTokens: sql<number>`COALESCE(SUM(${usageEventT.inputTokens}), 0)::int`,
    outputTokens: sql<number>`COALESCE(SUM(${usageEventT.outputTokens}), 0)::int`,
  })
    .from(usageEventT)
    .where(sql`
      ${usageEventT.organizationId} = ${orgId}
    AND
      DATE(${usageEventT.createdAt}) >= CURRENT_DATE - INTERVAL '29 days'
    `)
    .groupBy(sql`DATE(${usageEventT.createdAt})`)
    .orderBy(sql`DATE(${usageEventT.createdAt}) ASC`);
}

/** The five applications with the most calls in the last 30 days. */
export function topApplications(db: DB, orgId: string) {
  return db.select({
    applicationId: usageEventT.applicationId,
    totalCalls: sql<number>`COUNT(*) FILTER (WHERE ${usageEventT.success})::int`,
    totalTokens: sql<number>`COALESCE(SUM(${usageEventT.inputTokens} + ${usageEventT.outputTokens}), 0)::int`,
  })
    .from(usageEventT)
    .where(sql`
      ${usageEventT.organizationId} = ${orgId}
    AND
      ${usageEventT.createdAt} >= CURRENT_DATE - INTERVAL '29 days'
    `)
    .groupBy(usageEventT.applicationId)
    .orderBy(sql`COUNT(*) FILTER (WHERE ${usageEventT.success}) DESC`)
    .limit(5);
}
