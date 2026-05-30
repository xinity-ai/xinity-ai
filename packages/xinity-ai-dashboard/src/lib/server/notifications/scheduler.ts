import {
  sql,
  and,
  eq,
  gte,
  isNull,
  modelDeploymentT,
  modelInstallationT,
  modelInstallationStateT,
  aiNodeT,
  apiCallT,
  memberT,
  organizationT,
  userT,
  count,
  deploymentMatchesInstallation,
} from "common-db";
import { serverEnv } from "$lib/server/serverenv";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { building } from "$app/environment";
import { notify, notifyOrgMembers } from "./notification.service";
import { NotificationType } from "./events";
import { type DeploymentPhase, aggregatePhase } from "$lib/server/lib/deployment-phase";

const log = rootLogger.child({ name: "notification.scheduler" });

const CHECK_INTERVAL_MS = 5 * 60_000; // 5 minutes
const WEEKLY_CHECK_INTERVAL_MS = 60 * 60_000; // 1 hour
const WARMUP_DELAY_MS = 2_000;
const CAPACITY_WARNING_THRESHOLD = 0.8; // 80%
const MODELHUB_URL = `${serverEnv.ORIGIN}/modelhub`;

// ── In-memory state caches ──────────────────────────────────────────

/** Tracks the last known aggregate phase per deployment. */
const deploymentPhaseCache = new Map<string, DeploymentPhase>();

/** Tracks the last known availability per node. */
const nodeAvailabilityCache = new Map<string, boolean>();

/** Whether the initial snapshot has been taken (skip notifications on first run). */
let initialized = false;

/** Track if capacity warning was already sent (reset when capacity drops below threshold). */
let capacityWarningActive = false;

function pruneStaleCacheEntries<T>(cache: Map<string, T>, currentIds: Iterable<string>): void {
  const currentIdSet = currentIds instanceof Set ? currentIds : new Set(currentIds);
  for (const id of cache.keys()) {
    if (!currentIdSet.has(id)) cache.delete(id);
  }
}

async function notifyAllOrgs(
  type: NotificationType,
  data: Record<string, unknown>,
  failureLogMessage: string,
): Promise<void> {
  const orgs = await getDB().select({ id: organizationT.id }).from(organizationT);
  for (const org of orgs) {
    void notifyOrgMembers({ type, organizationId: org.id, data })
      .catch((err: unknown) => log.error({ err }, failureLogMessage));
  }
}

// ── Deployment status check ─────────────────────────────────────────

type DeploymentInfo = { phase: DeploymentPhase; orgId: string; orgName: string; name: string; model: string; error: string | null };

async function getDeploymentPhases(): Promise<Map<string, DeploymentInfo>> {
  const rows = await getDB()
    .select({
      deploymentId: modelDeploymentT.id,
      deploymentName: modelDeploymentT.name,
      organizationId: modelDeploymentT.organizationId,
      orgName: organizationT.name,
      publicSpecifier: modelDeploymentT.publicSpecifier,
      installationId: modelInstallationT.id,
      lifecycleState: modelInstallationStateT.lifecycleState,
      errorMessage: modelInstallationStateT.errorMessage,
    })
    .from(modelDeploymentT)
    .where(and(eq(modelDeploymentT.enabled, true), isNull(modelDeploymentT.deletedAt)))
    .leftJoin(organizationT, eq(organizationT.id, modelDeploymentT.organizationId))
    .leftJoin(modelInstallationT, and(deploymentMatchesInstallation, isNull(modelInstallationT.deletedAt)))
    .leftJoin(modelInstallationStateT, eq(modelInstallationStateT.id, modelInstallationT.id));

  const result = new Map<string, DeploymentInfo>();

  for (const row of rows) {
    const existing = result.get(row.deploymentId);
    const phase: DeploymentPhase = row.lifecycleState as DeploymentPhase ?? (row.installationId ? "scheduling" : "pending");

    if (!existing) {
      result.set(row.deploymentId, {
        phase,
        orgId: row.organizationId,
        orgName: row.orgName ?? "",
        name: row.deploymentName,
        model: row.publicSpecifier,
        error: row.errorMessage,
      });
    } else {
      const agg = aggregatePhase(
        { phase: existing.phase, progress: null, error: existing.error, failureLogs: null },
        phase, null, row.errorMessage,
      );
      result.set(row.deploymentId, {
        ...existing,
        phase: agg.phase,
        orgName: row.orgName ?? existing.orgName,
        error: agg.error,
      });
    }
  }

  return result;
}

function dispatchDeploymentPhaseNotification(
  deploymentId: string,
  info: DeploymentInfo,
  type: NotificationType,
  label: string,
  extraData: Record<string, unknown> = {},
): void {
  void notifyOrgMembers({
    type,
    organizationId: info.orgId,
    data: {
      deploymentName: info.name,
      modelSpecifier: info.model,
      orgName: info.orgName,
      dashboardUrl: MODELHUB_URL,
      ...extraData,
    },
  }).catch((err: unknown) => log.error({ err }, `Failed to send deployment ${label} notification`));
  log.info({ deploymentId, name: info.name }, `Deployment ${label} notification sent`);
}

async function checkDeploymentStatus() {
  try {
    const currentPhases = await getDeploymentPhases();

    for (const [deploymentId, info] of currentPhases) {
      const previousPhase = deploymentPhaseCache.get(deploymentId);
      deploymentPhaseCache.set(deploymentId, info.phase);

      if (!initialized || previousPhase === undefined) continue;
      if (previousPhase === info.phase) continue;

      if (info.phase === "ready") {
        dispatchDeploymentPhaseNotification(deploymentId, info, NotificationType.deployment_ready, "ready");
      } else if (info.phase === "failed") {
        dispatchDeploymentPhaseNotification(deploymentId, info, NotificationType.deployment_failed, "failed", {
          errorMessage: info.error ?? "An unknown error occurred during installation",
        });
      }
    }

    pruneStaleCacheEntries(deploymentPhaseCache, currentPhases.keys());
  } catch (err) {
    log.error({ err }, "Failed to check deployment status");
  }
}

// ── Node health check ───────────────────────────────────────────────

async function checkNodeHealth() {
  try {
    const nodes = await getDB()
      .select({ id: aiNodeT.id, host: aiNodeT.host, port: aiNodeT.port, available: aiNodeT.available })
      .from(aiNodeT)
      .where(isNull(aiNodeT.deletedAt));

    for (const node of nodes) {
      const previousAvailable = nodeAvailabilityCache.get(node.id);
      nodeAvailabilityCache.set(node.id, node.available);

      if (!initialized || previousAvailable === undefined) continue;
      if (previousAvailable === node.available) continue;

      const nodeHost = `${node.host}:${node.port}`;
      const type = node.available ? NotificationType.node_online : NotificationType.node_offline;

      await notifyAllOrgs(
        type,
        {
          nodeHost,
          status: node.available ? "online" : "offline",
          dashboardUrl: MODELHUB_URL,
        },
        "Failed to send node status notification",
      );

      log.info({ nodeId: node.id, host: nodeHost, available: node.available }, "Node status change notification sent");
    }

    pruneStaleCacheEntries(nodeAvailabilityCache, nodes.map(n => n.id));
  } catch (err) {
    log.error({ err }, "Failed to check node health");
  }
}

// ── Capacity check ──────────────────────────────────────────────────

async function checkCapacity() {
  try {
    const nodes = await getDB()
      .select({ id: aiNodeT.id, estCapacity: aiNodeT.estCapacity, available: aiNodeT.available })
      .from(aiNodeT)
      .where(and(eq(aiNodeT.available, true), isNull(aiNodeT.deletedAt)));

    const installations = await getDB()
      .select({ nodeId: modelInstallationT.nodeId, estCapacity: modelInstallationT.estCapacity })
      .from(modelInstallationT)
      .where(isNull(modelInstallationT.deletedAt));

    const totalCapacity = nodes.reduce((sum, n) => sum + n.estCapacity, 0);
    if (totalCapacity === 0) return;

    const usedCapacity = installations.reduce((sum, inst) => sum + inst.estCapacity, 0);
    const usedRatio = usedCapacity / totalCapacity;

    if (usedRatio < CAPACITY_WARNING_THRESHOLD) {
      capacityWarningActive = false;
      return;
    }
    if (capacityWarningActive) return;
    capacityWarningActive = true;

    const usedPercent = Math.round(usedRatio * 100);
    await notifyAllOrgs(
      NotificationType.capacity_warning,
      {
        usedPercent,
        totalCapacityGb: Math.round(totalCapacity * 10) / 10,
        usedCapacityGb: Math.round(usedCapacity * 10) / 10,
        dashboardUrl: MODELHUB_URL,
      },
      "Failed to send capacity warning notification",
    );
    log.info({ usedPercent, totalCapacity, usedCapacity }, "Capacity warning notification sent");
  } catch (err) {
    log.error({ err }, "Failed to check capacity");
  }
}

// ── Weekly report ───────────────────────────────────────────────────

async function countActiveDeployments(orgId: string): Promise<number> {
  const [row] = await getDB()
    .select({ count: count() })
    .from(modelDeploymentT)
    .where(and(
      eq(modelDeploymentT.organizationId, orgId),
      eq(modelDeploymentT.enabled, true),
      isNull(modelDeploymentT.deletedAt),
    ));
  return row?.count ?? 0;
}

async function countApiCallsSince(orgId: string, since: Date): Promise<number> {
  const [row] = await getDB()
    .select({ count: count() })
    .from(apiCallT)
    .where(and(eq(apiCallT.organizationId, orgId), gte(apiCallT.createdAt, since)));
  return row?.count ?? 0;
}

async function topModelsByCallsSince(orgId: string, since: Date, limit = 5): Promise<Array<{ name: string; calls: number }>> {
  return await getDB()
    .select({ name: apiCallT.model, calls: count() })
    .from(apiCallT)
    .where(and(eq(apiCallT.organizationId, orgId), gte(apiCallT.createdAt, since)))
    .groupBy(apiCallT.model)
    .orderBy(sql`count(*) DESC`)
    .limit(limit);
}

function formatReportPeriod(start: Date, end: Date): string {
  const startLabel = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endLabel = end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${startLabel} to ${endLabel}`;
}

const WEEKLY_REPORT_DOW_UTC = 1;
const WEEKLY_REPORT_HOUR_UTC = 8;

function isWeeklyReportSlot(now: Date): boolean {
  return now.getUTCDay() === WEEKLY_REPORT_DOW_UTC
    && now.getUTCHours() === WEEKLY_REPORT_HOUR_UTC;
}

async function checkWeeklyReport() {
  try {
    const now = new Date();
    if (!isWeeklyReportSlot(now)) return;

    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const [orgs, nodeResult] = await Promise.all([
      getDB().select({ id: organizationT.id, name: organizationT.name }).from(organizationT),
      getDB().select({ count: count() }).from(aiNodeT)
        .where(and(eq(aiNodeT.available, true), isNull(aiNodeT.deletedAt))),
    ]);
    const activeNodes = nodeResult[0]?.count ?? 0;
    const period = formatReportPeriod(oneWeekAgo, now);

    for (const org of orgs) {
      const [deploymentCount, totalApiCalls, topModels] = await Promise.all([
        countActiveDeployments(org.id),
        countApiCallsSince(org.id, oneWeekAgo),
        topModelsByCallsSince(org.id, oneWeekAgo),
      ]);

      void notifyOrgMembers({
        type: NotificationType.weekly_report,
        organizationId: org.id,
        data: {
          orgName: org.name,
          deploymentCount,
          activeNodes,
          totalApiCalls,
          topModels,
          period,
          dashboardUrl: serverEnv.ORIGIN,
        },
      }).catch((err: unknown) => log.error({ err }, "Failed to send weekly report notification"));

      log.info({ orgId: org.id, orgName: org.name }, "Weekly report sent");
    }
  } catch (err) {
    log.error({ err }, "Failed to send weekly reports");
  }
}

// ── Combined check ──────────────────────────────────────────────────

async function runChecks() {
  await Promise.all([checkDeploymentStatus(), checkNodeHealth(), checkCapacity()]);

  if (!initialized) {
    initialized = true;
    log.info("Notification scheduler initialized (first snapshot taken)");
  }
}

// ── Public API ──────────────────────────────────────────────────────

function scheduleRecurring(fn: () => unknown, intervalMs: number): void {
  const handle = setInterval(fn, intervalMs);
  process.on("beforeExit", () => clearInterval(handle));
}

export async function startNotificationScheduler() {
  if (building) return;

  log.info("Starting notification scheduler");

  await Bun.sleep(WARMUP_DELAY_MS);
  await runChecks();

  scheduleRecurring(runChecks, CHECK_INTERVAL_MS);
  // Weekly report check runs hourly; checkWeeklyReport gates on Monday 8 AM UTC.
  scheduleRecurring(checkWeeklyReport, WEEKLY_CHECK_INTERVAL_MS);
}
