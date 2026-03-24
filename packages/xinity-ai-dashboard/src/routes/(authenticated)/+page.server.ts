import { getDB } from "$lib/server/db";
import {
  sql, and, eq, inArray, isNull,
  aiApplicationT, apiCallT, apiCallResponseT, modelDeploymentT,
  usageEventT, usageSummaryT, NIL_APP_UUID, invitationT,
} from "common-db";
import type { PageServerLoad } from "./$types";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "dashboard-home" });

/** Roll up usageEvent rows older than 30 days into usageSummary, then delete them. */
async function rollupUsageEvents(db: ReturnType<typeof getDB>, orgId: string) {
  await db.execute(sql`
    INSERT INTO "call_data"."usage_summary"
      ("date", "organization_id", "application_id", "api_key_id", "model",
       "total_calls", "logged_calls", "input_tokens", "output_tokens", "total_duration")
    SELECT
      DATE("created_at"), "organization_id", COALESCE("application_id", '00000000-0000-0000-0000-000000000000'::uuid), "api_key_id", "model",
      COUNT(*)::int,
      COUNT(*) FILTER (WHERE "logged")::int,
      COALESCE(SUM("input_tokens"), 0),
      COALESCE(SUM("output_tokens"), 0),
      COALESCE(SUM("duration"), 0)
    FROM "call_data"."usage_event"
    WHERE "organization_id" = ${orgId} AND "created_at" < CURRENT_DATE - INTERVAL '30 days'
    GROUP BY DATE("created_at"), "organization_id", "application_id", "api_key_id", "model"
    ON CONFLICT ("date", "organization_id", "application_id", "api_key_id", "model")
    DO UPDATE SET
      "total_calls" = "usage_summary"."total_calls" + EXCLUDED."total_calls",
      "logged_calls" = "usage_summary"."logged_calls" + EXCLUDED."logged_calls",
      "input_tokens" = "usage_summary"."input_tokens" + EXCLUDED."input_tokens",
      "output_tokens" = "usage_summary"."output_tokens" + EXCLUDED."output_tokens",
      "total_duration" = "usage_summary"."total_duration" + EXCLUDED."total_duration"
  `);

  await db.delete(usageEventT).where(and(
    eq(usageEventT.organizationId, orgId),
    sql`${usageEventT.createdAt} < CURRENT_DATE - INTERVAL '30 days'`,
  ));
}

export const load: PageServerLoad = async ({ parent }) => {
  const { user, session } = await parent();
  const userId = user.id;
  const activeOrgId = session.activeOrganizationId;

  if (!activeOrgId) {
    return {
      noOrg: true,
      ...emptyData(),
    };
  }

  const db = getDB();

  // Fire-and-forget rollup of old usage events
  rollupUsageEvents(db, activeOrgId).catch(err => log.error({ err }, "Rollup error"));

  // Run all independent queries in parallel
  const [
    [eventTotalsResult],
    [summaryTotalsResult],
    [todayResult],
    [tokenAvgResult],
    recentModels,
    [ratingsResult],
    [trainingDataResult],
    trendData,
    topAppsRaw,
    [avgDurationResult],
    recentActivitiesResult,
  ] = await Promise.all([
    // Usage totals from usageEvent (recent, last 30 days)
    db.select({
      totalCalls: sql<number>`COUNT(*)::int`,
      loggedCalls: sql<number>`COUNT(*) FILTER (WHERE ${usageEventT.logged})::int`,
    })
      .from(usageEventT)
      .where(eq(usageEventT.organizationId, activeOrgId)),

    // Usage totals from usageSummary (older, rolled up)
    db.select({
      totalCalls: sql<number>`COALESCE(SUM(${usageSummaryT.totalCalls}), 0)::int`,
      loggedCalls: sql<number>`COALESCE(SUM(${usageSummaryT.loggedCalls}), 0)::int`,
    })
      .from(usageSummaryT)
      .where(eq(usageSummaryT.organizationId, activeOrgId)),

    // Today's usage
    db.select({
      totalCalls: sql<number>`COUNT(*)::int`,
      loggedCalls: sql<number>`COUNT(*) FILTER (WHERE ${usageEventT.logged})::int`,
    })
      .from(usageEventT)
      .where(and(
        eq(usageEventT.organizationId, activeOrgId),
        sql`DATE(${usageEventT.createdAt}) = CURRENT_DATE`,
      )),

    // Mean tokens per call: last 1m, 10m, 1h (split by input/output)
    db.select({
      avgInput1m: sql<number | null>`AVG(${usageEventT.inputTokens}) FILTER (WHERE ${usageEventT.createdAt} > NOW() - INTERVAL '1 minute')`,
      avgOutput1m: sql<number | null>`AVG(${usageEventT.outputTokens}) FILTER (WHERE ${usageEventT.createdAt} > NOW() - INTERVAL '1 minute')`,
      avgInput10m: sql<number | null>`AVG(${usageEventT.inputTokens}) FILTER (WHERE ${usageEventT.createdAt} > NOW() - INTERVAL '10 minutes')`,
      avgOutput10m: sql<number | null>`AVG(${usageEventT.outputTokens}) FILTER (WHERE ${usageEventT.createdAt} > NOW() - INTERVAL '10 minutes')`,
      avgInput1h: sql<number | null>`AVG(${usageEventT.inputTokens}) FILTER (WHERE ${usageEventT.createdAt} > NOW() - INTERVAL '1 hour')`,
      avgOutput1h: sql<number | null>`AVG(${usageEventT.outputTokens}) FILTER (WHERE ${usageEventT.createdAt} > NOW() - INTERVAL '1 hour')`,
    })
      .from(usageEventT)
      .where(and(
        eq(usageEventT.organizationId, activeOrgId),
        sql`${usageEventT.createdAt} > NOW() - INTERVAL '1 hour'`,
      )),

    db.select({
        name: modelDeploymentT.name,
        status: sql<string>`'deployed'`,
      })
      .from(modelDeploymentT)
      .where(sql`
        ${modelDeploymentT.organizationId} = ${activeOrgId} 
      AND 
        ${modelDeploymentT.deletedAt} IS NULL
      `)
      .orderBy(sql`${modelDeploymentT.createdAt} DESC`)
      .limit(3),

    db.select({
        liked: sql<number>`COUNT(CASE WHEN ${apiCallResponseT.response} = true THEN 1 END)::int`,
        disliked: sql<number>`COUNT(CASE WHEN ${apiCallResponseT.response} = false THEN 1 END)::int`,
        unrated: sql<number>`COUNT(CASE WHEN ${apiCallResponseT.response} IS NULL THEN 1 END)::int`,
      })
      .from(apiCallResponseT)
      .where(sql`${apiCallResponseT.userId} = ${activeOrgId}`),

    db.select({
        total: sql<number>`COUNT(*)::int`,
        edited: sql<number>`COUNT(CASE WHEN ${apiCallResponseT.outputEdit} IS NOT NULL THEN 1 END)::int`,
        rated: sql<number>`COUNT(CASE WHEN ${apiCallResponseT.response} IS NOT NULL THEN 1 END)::int`,
      })
      .from(apiCallResponseT)
      .where(sql`${apiCallResponseT.userId} = ${userId}`),

    // 30-day trend from usageEvent (calls + tokens per day)
    db.select({
        date: sql<string>`DATE(${usageEventT.createdAt})`,
        totalCalls: sql<number>`COUNT(*)::int`,
        loggedCalls: sql<number>`COUNT(*) FILTER (WHERE ${usageEventT.logged})::int`,
        inputTokens: sql<number>`COALESCE(SUM(${usageEventT.inputTokens}), 0)::int`,
        outputTokens: sql<number>`COALESCE(SUM(${usageEventT.outputTokens}), 0)::int`,
      })
      .from(usageEventT)
      .where(and(
        eq(usageEventT.organizationId, activeOrgId),
        sql`DATE(${usageEventT.createdAt}) >= CURRENT_DATE - INTERVAL '29 days'`,
      ))
      .groupBy(sql`DATE(${usageEventT.createdAt})`)
      .orderBy(sql`DATE(${usageEventT.createdAt}) ASC`),

    // Top applications by usage (last 30 days)
    db.select({
        applicationId: usageEventT.applicationId,
        totalCalls: sql<number>`COUNT(*)::int`,
        totalTokens: sql<number>`COALESCE(SUM(${usageEventT.inputTokens} + ${usageEventT.outputTokens}), 0)::int`,
      })
      .from(usageEventT)
      .where(and(
        eq(usageEventT.organizationId, activeOrgId),
        sql`${usageEventT.createdAt} >= CURRENT_DATE - INTERVAL '29 days'`,
      ))
      .groupBy(usageEventT.applicationId)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(5),

    // Average response duration from all usage events
    db.select({ avg: sql<number>`AVG(${usageEventT.duration})` })
      .from(usageEventT)
      .where(eq(usageEventT.organizationId, activeOrgId)),

    // Recent activities from usage events (all calls, not just logged)
    db.select({
        model: usageEventT.model,
        timestamp: usageEventT.createdAt,
        inputTokens: usageEventT.inputTokens,
        outputTokens: usageEventT.outputTokens,
        duration: usageEventT.duration,
        logged: usageEventT.logged,
      })
      .from(usageEventT)
      .where(eq(usageEventT.organizationId, activeOrgId))
      .orderBy(sql`${usageEventT.createdAt} DESC`)
      .limit(5),
  ]);

  // Combine event + summary totals
  const totalCalls = (eventTotalsResult?.totalCalls || 0) + (summaryTotalsResult?.totalCalls || 0);
  const loggedCalls = (eventTotalsResult?.loggedCalls || 0) + (summaryTotalsResult?.loggedCalls || 0);
  const todayCalls = todayResult?.totalCalls || 0;
  const todayLoggedCalls = todayResult?.loggedCalls || 0;

  const avgDuration = avgDurationResult?.avg ?? null;
  const avgResponseTime = avgDuration ? Number((avgDuration / 1000).toFixed(1)) : 0;
  const totalRated = (ratingsResult?.liked || 0) + (ratingsResult?.disliked || 0);
  const approvalRate = totalRated === 0 ? 0 : Number((((ratingsResult?.liked || 0) / totalRated) * 100).toFixed(1));

  const totalDatapoints = trainingDataResult?.total || 0;
  const editedCount = trainingDataResult?.edited || 0;
  const ratedCount = trainingDataResult?.rated || 0;

  // Fill in missing days with zeros for the 30-day trend
  const trendMap = new Map(trendData.map(d => [d.date, d]));
  const usageTrend: Array<{ totalCalls: number; loggedCalls: number; inputTokens: number; outputTokens: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const dayData = trendMap.get(dateStr);
    usageTrend.push({
      totalCalls: dayData?.totalCalls || 0,
      loggedCalls: dayData?.loggedCalls || 0,
      inputTokens: dayData?.inputTokens || 0,
      outputTokens: dayData?.outputTokens || 0,
    });
  }

  // Resolve application names for top apps
  const appIds = topAppsRaw.map(a => a.applicationId).filter(id => id != null && id !== NIL_APP_UUID) as string[];
  let appNameMap = new Map<string, string>();
  if (appIds.length > 0) {
    const apps = await db
      .select({ id: aiApplicationT.id, name: aiApplicationT.name })
      .from(aiApplicationT)
      .where(inArray(aiApplicationT.id, appIds));
    appNameMap = new Map(apps.map(a => [a.id, a.name]));
  }

  const topApplications = topAppsRaw.map(a => ({
    name: (a.applicationId == null || a.applicationId === NIL_APP_UUID) ? 'Uncategorized' : (appNameMap.get(a.applicationId) ?? 'Unknown'),
    totalCalls: a.totalCalls,
    totalTokens: a.totalTokens,
  }));

  // Checklist completion queries (all LIMIT 1 existence checks)
  const [
    checkDeployment,
    checkApiCall,
    checkLabeledCall,
    checkInvitation,
    checkApplication,
  ] = await Promise.all([
    db.select({ id: modelDeploymentT.id })
      .from(modelDeploymentT)
      .where(
        sql`
          ${modelDeploymentT.organizationId} = ${activeOrgId}
        AND
          ${modelDeploymentT.deletedAt} IS NULL
        `,
       )
      .limit(1),

    db.select({ id: usageEventT.id })
      .from(usageEventT)
      .where(eq(usageEventT.organizationId, activeOrgId))
      .limit(1),

    db.select({ id: apiCallResponseT.apiCallId })
      .from(apiCallResponseT)
      .innerJoin(apiCallT, eq(apiCallT.id, apiCallResponseT.apiCallId))
      .where(eq(apiCallT.organizationId, activeOrgId))
      .limit(1),

    db.select({ id: invitationT.id })
      .from(invitationT)
      .where(eq(invitationT.organizationId, activeOrgId))
      .limit(1),

    db.select({ id: aiApplicationT.id })
      .from(aiApplicationT)
      .where(and(
        eq(aiApplicationT.organizationId, activeOrgId),
        isNull(aiApplicationT.deletedAt),
      ))
      .limit(1),
  ]);

  return {
    apiCallStats: { totalCalls, loggedCalls, todayCalls, todayLoggedCalls, approvalRate, avgResponseTime },
    tokenStats: {
      avgInput1m: tokenAvgResult?.avgInput1m != null ? Math.round(tokenAvgResult.avgInput1m) : null,
      avgOutput1m: tokenAvgResult?.avgOutput1m != null ? Math.round(tokenAvgResult.avgOutput1m) : null,
      avgInput10m: tokenAvgResult?.avgInput10m != null ? Math.round(tokenAvgResult.avgInput10m) : null,
      avgOutput10m: tokenAvgResult?.avgOutput10m != null ? Math.round(tokenAvgResult.avgOutput10m) : null,
      avgInput1h: tokenAvgResult?.avgInput1h != null ? Math.round(tokenAvgResult.avgInput1h) : null,
      avgOutput1h: tokenAvgResult?.avgOutput1h != null ? Math.round(tokenAvgResult.avgOutput1h) : null,
    },
    recentModels: recentModels.map(m => ({ name: m.name, status: m.status })),
    topApplications,
    responseRatings: {
      liked: ratingsResult?.liked || 0,
      disliked: ratingsResult?.disliked || 0,
      unrated: ratingsResult?.unrated || 0,
    },
    trainingData: {
      datapoints: totalDatapoints,
      edited: totalDatapoints > 0 ? Math.round((editedCount / totalDatapoints) * 100) : 0,
      rated: totalDatapoints > 0 ? Math.round((ratedCount / totalDatapoints) * 100) : 0,
    },
    recentActivities: recentActivitiesResult.map(a => ({
      model: a.model,
      timestamp: a.timestamp.toISOString(),
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      duration: a.duration,
      logged: a.logged,
    })),
    usageTrend,
    checklist: {
      hasOrganization: true,
      hasDeployment: checkDeployment.length > 0,
      hasApiCall: checkApiCall.length > 0,
      hasLabeledCall: checkLabeledCall.length > 0,
      hasInvitation: checkInvitation.length > 0,
      hasApplication: checkApplication.length > 0,
    },
  };
};

function emptyData() {
  return {
    apiCallStats: {
      totalCalls: 0,
      loggedCalls: 0,
      todayCalls: 0,
      todayLoggedCalls: 0,
      approvalRate: 0,
      avgResponseTime: 0,
    },
    tokenStats: {
      avgInput1m: null as number | null,
      avgOutput1m: null as number | null,
      avgInput10m: null as number | null,
      avgOutput10m: null as number | null,
      avgInput1h: null as number | null,
      avgOutput1h: null as number | null,
    },
    recentModels: [],
    topApplications: [],
    responseRatings: {
      liked: 0,
      disliked: 0,
      unrated: 0,
    },
    trainingData: {
      datapoints: 0,
      edited: 0,
      rated: 0,
    },
    recentActivities: [] as Array<{ model: string; timestamp: string; inputTokens: number; outputTokens: number; duration: number | null; logged: boolean }>,
    usageTrend: Array.from({ length: 30 }, () => ({
      totalCalls: 0,
      loggedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    })),
    checklist: {
      hasOrganization: false,
      hasDeployment: false,
      hasApiCall: false,
      hasLabeledCall: false,
      hasInvitation: false,
      hasApplication: false,
    },
  }
}
