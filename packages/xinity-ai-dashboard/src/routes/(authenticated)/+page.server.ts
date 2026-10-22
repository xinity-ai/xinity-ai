import { getDB } from "$lib/server/db";
import {
  sql, inArray,
  aiApplicationT, modelDeploymentT,
  usageEventT, usageSummaryT, NIL_APP_UUID, invitationT,
} from "common-db";
import type { PageServerLoad } from "./$types";
import type { ChecklistData, KeyMetrics, ChartsData, TablesData, UsageTrendEntry } from "./dashboard.types";
import { organizationHasRating, resolveRatingTotals } from "$lib/server/lib/calls/call-ratings";
import { rootLogger } from "$lib/server/logging";
import { hasOrgPermission, type PermissionSpec } from "$lib/server/lib/auth/permissions";

const log = rootLogger.child({ name: "dashboard-home" });

type DB = ReturnType<typeof getDB>;

const roundOrNull = (n: number | null | undefined): number | null =>
  n != null ? Math.round(n) : null;

const isUncategorizedApp = (id: string | null | undefined): boolean =>
  id == null || id === NIL_APP_UUID;

function fillDailyTrendSeries(trendData: UsageTrendEntry[], days: string[]): UsageTrendEntry[] {
  const trendMap = new Map(trendData.map(d => [d.date, d]));
  return days.map((date) => {
    const dayData = trendMap.get(date);
    return {
      date,
      totalCalls: dayData?.totalCalls ?? 0,
      loggedCalls: dayData?.loggedCalls ?? 0,
      inputTokens: dayData?.inputTokens ?? 0,
      outputTokens: dayData?.outputTokens ?? 0,
    };
  });
}

/**
 * Moves usageEvent rows older than 30 days into usageSummary. One statement, so overlapping
 * runs cannot both move the same rows. The summary cannot tell failures apart, so they are
 * deleted without being counted.
 */
async function rollupUsageEvents(db: DB, orgId: string) {
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
      COUNT(*)::int,
      COUNT(*) FILTER (WHERE "logged")::int,
      COALESCE(SUM("input_tokens"), 0),
      COALESCE(SUM("output_tokens"), 0),
      COALESCE(SUM("duration"), 0)
    FROM moved
    WHERE "success"
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

const succeededInOrg = (orgId: string) => sql`${usageEventT.organizationId} = ${orgId} AND ${usageEventT.success}`;

async function loadKeyMetrics(db: DB, orgId: string, userId: string): Promise<KeyMetrics> {
  const [
    [eventTotalsResult],
    [summaryTotalsResult],
    [todayResult],
    [tokenAvgResult],
    responseDataResult,
  ] = await Promise.all([
    // Usage totals + avg duration from usageEvent, same table and filter
    db.select({
      totalCalls: sql<number>`COUNT(*)::int`,
      loggedCalls: sql<number>`COUNT(*) FILTER (WHERE ${usageEventT.logged})::int`,
      avgDuration: sql<number | null>`AVG(${usageEventT.duration})`,
    })
      .from(usageEventT)
      .where(succeededInOrg(orgId)),

    db.select({
      totalCalls: sql<number>`COALESCE(SUM(${usageSummaryT.totalCalls}), 0)::int`,
      loggedCalls: sql<number>`COALESCE(SUM(${usageSummaryT.loggedCalls}), 0)::int`,
    })
      .from(usageSummaryT)
      .where(sql`${usageSummaryT.organizationId} = ${orgId}`),

    db.select({
      totalCalls: sql<number>`COUNT(*)::int`,
      loggedCalls: sql<number>`COUNT(*) FILTER (WHERE ${usageEventT.logged})::int`,
    })
      .from(usageEventT)
      .where(sql`
        ${succeededInOrg(orgId)}
      AND
        DATE(${usageEventT.createdAt}) = CURRENT_DATE
      `),

    db.select({
      avgInput1m: sql<number | null>`AVG(${usageEventT.inputTokens}) FILTER (WHERE ${usageEventT.createdAt} > NOW() - INTERVAL '1 minute')`,
      avgOutput1m: sql<number | null>`AVG(${usageEventT.outputTokens}) FILTER (WHERE ${usageEventT.createdAt} > NOW() - INTERVAL '1 minute')`,
      avgInput10m: sql<number | null>`AVG(${usageEventT.inputTokens}) FILTER (WHERE ${usageEventT.createdAt} > NOW() - INTERVAL '10 minutes')`,
      avgOutput10m: sql<number | null>`AVG(${usageEventT.outputTokens}) FILTER (WHERE ${usageEventT.createdAt} > NOW() - INTERVAL '10 minutes')`,
      avgInput1h: sql<number | null>`AVG(${usageEventT.inputTokens}) FILTER (WHERE ${usageEventT.createdAt} > NOW() - INTERVAL '1 hour')`,
      avgOutput1h: sql<number | null>`AVG(${usageEventT.outputTokens}) FILTER (WHERE ${usageEventT.createdAt} > NOW() - INTERVAL '1 hour')`,
    })
      .from(usageEventT)
      .where(sql`
        ${succeededInOrg(orgId)}
      AND
        ${usageEventT.createdAt} > NOW() - INTERVAL '1 hour'
      `),

    resolveRatingTotals(userId),
  ]);

  const totalCalls = (eventTotalsResult?.totalCalls || 0) + (summaryTotalsResult?.totalCalls || 0);
  const loggedCalls = (eventTotalsResult?.loggedCalls || 0) + (summaryTotalsResult?.loggedCalls || 0);
  const avgDuration = eventTotalsResult?.avgDuration ?? null;
  const avgResponseTime = avgDuration ? Number((avgDuration / 1000).toFixed(1)) : 0;
  const totalRated = responseDataResult?.rated || 0;
  const approvalRate = totalRated === 0 ? 0 : Number((((responseDataResult?.liked || 0) / totalRated) * 100).toFixed(1));
  const totalDatapoints = responseDataResult?.total || 0;
  const editedCount = responseDataResult?.edited || 0;
  const ratedCount = responseDataResult?.rated || 0;
  const percentOfDatapoints = (count: number) =>
    totalDatapoints > 0 ? Math.round((count / totalDatapoints) * 100) : 0;

  return {
    apiCallStats: {
      totalCalls,
      loggedCalls,
      todayCalls: todayResult?.totalCalls || 0,
      todayLoggedCalls: todayResult?.loggedCalls || 0,
      approvalRate,
      avgResponseTime,
    },
    tokenStats: {
      avgInput1m: roundOrNull(tokenAvgResult?.avgInput1m),
      avgOutput1m: roundOrNull(tokenAvgResult?.avgOutput1m),
      avgInput10m: roundOrNull(tokenAvgResult?.avgInput10m),
      avgOutput10m: roundOrNull(tokenAvgResult?.avgOutput10m),
      avgInput1h: roundOrNull(tokenAvgResult?.avgInput1h),
      avgOutput1h: roundOrNull(tokenAvgResult?.avgOutput1h),
    },
    responseRatings: {
      liked: responseDataResult?.liked || 0,
      disliked: responseDataResult?.disliked || 0,
      unrated: responseDataResult?.unrated || 0,
    },
    trainingData: {
      datapoints: totalDatapoints,
      edited: percentOfDatapoints(editedCount),
      rated: percentOfDatapoints(ratedCount),
    },
  };
}

async function fetchApplicationNames(db: DB, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const apps = await db
    .select({ id: aiApplicationT.id, name: aiApplicationT.name })
    .from(aiApplicationT)
    .where(inArray(aiApplicationT.id, ids));
  return new Map(apps.map(a => [a.id, a.name]));
}

async function loadCharts(db: DB, orgId: string): Promise<ChartsData> {
  const [trendDays, trendData, topAppsRaw] = await Promise.all([
    // The day keys come from the database too, so they follow the same clock as DATE(created_at).
    db.execute<{ date: string }>(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS date
      FROM generate_series(CURRENT_DATE - 29, CURRENT_DATE, INTERVAL '1 day') AS day
      ORDER BY day
    `),

    db.select({
      date: sql<string>`to_char(DATE(${usageEventT.createdAt}), 'YYYY-MM-DD')`,
      totalCalls: sql<number>`COUNT(*)::int`,
      loggedCalls: sql<number>`COUNT(*) FILTER (WHERE ${usageEventT.logged})::int`,
      inputTokens: sql<number>`COALESCE(SUM(${usageEventT.inputTokens}), 0)::int`,
      outputTokens: sql<number>`COALESCE(SUM(${usageEventT.outputTokens}), 0)::int`,
    })
      .from(usageEventT)
      .where(sql`
        ${succeededInOrg(orgId)}
      AND
        DATE(${usageEventT.createdAt}) >= CURRENT_DATE - INTERVAL '29 days'
      `)
      .groupBy(sql`DATE(${usageEventT.createdAt})`)
      .orderBy(sql`DATE(${usageEventT.createdAt}) ASC`),

    db.select({
      applicationId: usageEventT.applicationId,
      totalCalls: sql<number>`COUNT(*)::int`,
      totalTokens: sql<number>`COALESCE(SUM(${usageEventT.inputTokens} + ${usageEventT.outputTokens}), 0)::int`,
    })
      .from(usageEventT)
      .where(sql`
        ${succeededInOrg(orgId)}
      AND
        ${usageEventT.createdAt} >= CURRENT_DATE - INTERVAL '29 days'
      `)
      .groupBy(usageEventT.applicationId)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(5),
  ]);

  const usageTrend = fillDailyTrendSeries(trendData, trendDays.map(row => row.date));

  const appIds = topAppsRaw.map(a => a.applicationId).filter((id): id is string => !isUncategorizedApp(id));
  const appNameMap = await fetchApplicationNames(db, appIds);

  return {
    usageTrend,
    topApplications: topAppsRaw.map(a => ({
      name: isUncategorizedApp(a.applicationId) ? 'Uncategorized' : (appNameMap.get(a.applicationId!) ?? 'Unknown'),
      totalCalls: a.totalCalls,
      totalTokens: a.totalTokens,
    })),
  };
}

async function loadTables(db: DB, orgId: string, includeDeployments: boolean): Promise<TablesData> {
  const [recentActivitiesResult, recentModels] = await Promise.all([
    db.select({
      model: usageEventT.model,
      timestamp: usageEventT.createdAt,
      inputTokens: usageEventT.inputTokens,
      outputTokens: usageEventT.outputTokens,
      duration: usageEventT.duration,
      logged: usageEventT.logged,
    })
      .from(usageEventT)
      .where(sql`${usageEventT.organizationId} = ${orgId}`)
      .orderBy(sql`${usageEventT.createdAt} DESC`)
      .limit(5),

    includeDeployments
      ? db.select({
        name: modelDeploymentT.name,
      })
        .from(modelDeploymentT)
        .where(sql`
          ${modelDeploymentT.organizationId} = ${orgId}
        AND
          ${modelDeploymentT.deletedAt} IS NULL
        `)
        .orderBy(sql`${modelDeploymentT.createdAt} DESC`)
        .limit(3)
      : [],
  ]);

  return {
    recentActivities: recentActivitiesResult.map(({ timestamp, ...rest }) => ({
      ...rest,
      timestamp: timestamp.toISOString(),
    })),
    recentModels: recentModels.map(m => ({ name: m.name, status: "deployed" as const })),
  };
}

async function loadIfPermitted<T>(allowed: Promise<boolean>, load: () => Promise<T>, fallback: Promise<T>): Promise<T> {
  return (await allowed) ? load() : fallback;
}

export const load: PageServerLoad = async ({ parent, request }) => {
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
  void rollupUsageEvents(db, activeOrgId)
    .catch(err => log.error({ err }, "Usage info rollup error"));

  const can = (permissions: PermissionSpec) => hasOrgPermission(request.headers, activeOrgId, permissions);
  const canReadUsage = can({ apiCall: ["read"] });
  const empty = emptyData();

  // Stream all data. Page renders immediately, sections fill in as queries resolve.
  return {
    checklist: loadIfPermitted(canReadUsage, () => loadChecklist(db, activeOrgId),
      empty.checklist.then((checklist) => ({ ...checklist, hasOrganization: true }))),
    keyMetrics: loadIfPermitted(can({ apiCall: ["read"], callRating: ["read"] }),
      () => loadKeyMetrics(db, activeOrgId, userId), empty.keyMetrics),
    charts: loadIfPermitted(can({ apiCall: ["read"], aiApplication: ["read"] }),
      () => loadCharts(db, activeOrgId), empty.charts),
    tables: loadIfPermitted(canReadUsage,
      async () => loadTables(db, activeOrgId, await can({ modelDeployment: ["read"] })), empty.tables),
  };
};

async function loadChecklist(db: DB, orgId: string): Promise<ChecklistData> {
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
          ${modelDeploymentT.organizationId} = ${orgId}
        AND
          ${modelDeploymentT.deletedAt} IS NULL
        `,
      )
      .limit(1),

    db.select({ id: usageEventT.id })
      .from(usageEventT)
      .where(sql`${usageEventT.organizationId} = ${orgId}`)
      .limit(1),

    organizationHasRating(orgId),

    db.select({ id: invitationT.id })
      .from(invitationT)
      .where(sql`${invitationT.organizationId} = ${orgId}`)
      .limit(1),

    db.select({ id: aiApplicationT.id })
      .from(aiApplicationT)
      .where(sql`
        ${aiApplicationT.organizationId} = ${orgId}
      AND
        ${aiApplicationT.deletedAt} IS NULL
      `)
      .limit(1),
  ]);

  return {
    hasOrganization: true,
    hasDeployment: checkDeployment.length > 0,
    hasApiCall: checkApiCall.length > 0,
    hasLabeledCall: checkLabeledCall,
    hasInvitation: checkInvitation.length > 0,
    hasApplication: checkApplication.length > 0,
  };
}

function emptyData() {
  return {
    checklist: Promise.resolve<ChecklistData>({
      hasOrganization: false,
      hasDeployment: false,
      hasApiCall: false,
      hasLabeledCall: false,
      hasInvitation: false,
      hasApplication: false,
    }),
    keyMetrics: Promise.resolve<KeyMetrics>({
      apiCallStats: {
        totalCalls: 0,
        loggedCalls: 0,
        todayCalls: 0,
        todayLoggedCalls: 0,
        approvalRate: 0,
        avgResponseTime: 0,
      },
      tokenStats: {
        avgInput1m: null,
        avgOutput1m: null,
        avgInput10m: null,
        avgOutput10m: null,
        avgInput1h: null,
        avgOutput1h: null,
      },
      responseRatings: { liked: 0, disliked: 0, unrated: 0 },
      trainingData: { datapoints: 0, edited: 0, rated: 0 },
    }),
    charts: Promise.resolve<ChartsData>({
      usageTrend: [],
      topApplications: [],
    }),
    tables: Promise.resolve<TablesData>({
      recentActivities: [],
      recentModels: [],
    }),
  };
}
