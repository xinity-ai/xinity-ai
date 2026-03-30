import {
  sql,
  modelDeploymentT,
  modelInstallationT,
  modelInstallationStateT,
  aiNodeT,
  apiCallT,
  memberT,
  organizationT,
  userT,
  count,
} from "common-db";
import { serverEnv } from "$lib/server/serverenv";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { building } from "$app/environment";
import { notify, notifyOrgMembers } from "./notification.service";
import { NotificationType } from "./events";
import { type DeploymentPhase, PHASE_PRIORITY, aggregatePhase } from "$lib/server/lib/deployment-phase";

const log = rootLogger.child({ name: "notification.scheduler" });

const CHECK_INTERVAL_MS = 5 * 60_000; // 5 minutes
const WEEKLY_CHECK_INTERVAL_MS = 60 * 60_000; // 1 hour
const CAPACITY_WARNING_THRESHOLD = 0.8; // 80%

// ── In-memory state caches ──────────────────────────────────────────

/** Tracks the last known aggregate phase per deployment. */
const deploymentPhaseCache = new Map<string, DeploymentPhase>();

/** Tracks the last known availability per node. */
const nodeAvailabilityCache = new Map<string, boolean>();

/** Whether the initial snapshot has been taken (skip notifications on first run). */
let initialized = false;

/** Track if capacity warning was already sent (reset when capacity drops below threshold). */
let capacityWarningActive = false;

// ── Deployment status check ─────────────────────────────────────────

async function getDeploymentPhases(): Promise<Map<string, { phase: DeploymentPhase; orgId: string; orgName: string; name: string; model: string; error: string | null }>> {
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
    .where(sql`${modelDeploymentT.enabled} = true AND ${modelDeploymentT.deletedAt} IS NULL`)
    .leftJoin(organizationT, sql`${organizationT.id} = ${modelDeploymentT.organizationId}`)
    .leftJoin(modelInstallationT, sql`
      (${modelDeploymentT.modelSpecifier} = ${modelInstallationT.model}
      OR ${modelDeploymentT.earlyModelSpecifier} = ${modelInstallationT.model})
      AND ${modelInstallationT.deletedAt} IS NULL`)
    .leftJoin(modelInstallationStateT, sql`${modelInstallationStateT.id} = ${modelInstallationT.id}`);

  type DeploymentInfo = { phase: DeploymentPhase; orgId: string; orgName: string; name: string; model: string; error: string | null };
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

async function checkDeploymentStatus() {
  try {
    const currentPhases = await getDeploymentPhases();

    for (const [deploymentId, info] of currentPhases) {
      const previousPhase = deploymentPhaseCache.get(deploymentId);
      deploymentPhaseCache.set(deploymentId, info.phase);

      if (!initialized || previousPhase === undefined) continue;
      if (previousPhase === info.phase) continue;

      if (info.phase === "ready" && previousPhase !== "ready") {
        void notifyOrgMembers({
          type: NotificationType.deployment_ready,
          organizationId: info.orgId,
          data: {
            deploymentName: info.name,
            modelSpecifier: info.model,
            orgName: info.orgName,
            dashboardUrl: `${serverEnv.ORIGIN}/modelhub`,
          },
        }).catch((err: unknown) => log.error({ err }, "Failed to send deployment ready notification"));
        log.info({ deploymentId, name: info.name }, "Deployment ready notification sent");
      }

      if (info.phase === "failed" && previousPhase !== "failed") {
        void notifyOrgMembers({
          type: NotificationType.deployment_failed,
          organizationId: info.orgId,
          data: {
            deploymentName: info.name,
            modelSpecifier: info.model,
            errorMessage: info.error ?? "An unknown error occurred during installation",
            orgName: info.orgName,
            dashboardUrl: `${serverEnv.ORIGIN}/modelhub`,
          },
        }).catch((err: unknown) => log.error({ err }, "Failed to send deployment failed notification"));
        log.info({ deploymentId, name: info.name }, "Deployment failed notification sent");
      }
    }

    // Clean up stale entries for deployments that no longer exist
    for (const id of deploymentPhaseCache.keys()) {
      if (!currentPhases.has(id)) {
        deploymentPhaseCache.delete(id);
      }
    }
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
      .where(sql`${aiNodeT.deletedAt} IS NULL`);

    for (const node of nodes) {
      const previousAvailable = nodeAvailabilityCache.get(node.id);
      nodeAvailabilityCache.set(node.id, node.available);

      if (!initialized || previousAvailable === undefined) continue;
      if (previousAvailable === node.available) continue;

      const nodeHost = `${node.host}:${node.port}`;
      const type = node.available ? NotificationType.node_online : NotificationType.node_offline;

      // Node health is instance-wide, notify all admin/owner members across all orgs
      const orgs = await getDB().select({ id: organizationT.id }).from(organizationT);
      for (const org of orgs) {
        void notifyOrgMembers({
          type,
          organizationId: org.id,
          data: {
            nodeHost,
            status: node.available ? "online" : "offline",
            dashboardUrl: `${serverEnv.ORIGIN}/modelhub`,
          },
        }).catch((err: unknown) => log.error({ err }, "Failed to send node status notification"));
      }

      log.info({ nodeId: node.id, host: nodeHost, available: node.available }, "Node status change notification sent");
    }

    // Clean up stale entries
    const currentIds = new Set(nodes.map(n => n.id));
    for (const id of nodeAvailabilityCache.keys()) {
      if (!currentIds.has(id)) {
        nodeAvailabilityCache.delete(id);
      }
    }
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
      .where(sql`${aiNodeT.available} = true AND ${aiNodeT.deletedAt} IS NULL`);

    const installations = await getDB()
      .select({ nodeId: modelInstallationT.nodeId, estCapacity: modelInstallationT.estCapacity })
      .from(modelInstallationT)
      .where(sql`${modelInstallationT.deletedAt} IS NULL`);

    const totalCapacity = nodes.reduce((sum, n) => sum + n.estCapacity, 0);
    if (totalCapacity === 0) return;

    const usedByNode = new Map<string, number>();
    for (const inst of installations) {
      usedByNode.set(inst.nodeId, (usedByNode.get(inst.nodeId) ?? 0) + inst.estCapacity);
    }
    const usedCapacity = Array.from(usedByNode.values()).reduce((sum, v) => sum + v, 0);
    const usedPercent = Math.round((usedCapacity / totalCapacity) * 100);

    if (usedPercent >= CAPACITY_WARNING_THRESHOLD * 100) {
      if (!capacityWarningActive) {
        capacityWarningActive = true;

        // Notify all orgs
        const orgs = await getDB().select({ id: organizationT.id }).from(organizationT);
        for (const org of orgs) {
          void notifyOrgMembers({
            type: NotificationType.capacity_warning,
            organizationId: org.id,
            data: {
              usedPercent,
              totalCapacityGb: Math.round(totalCapacity * 10) / 10,
              usedCapacityGb: Math.round(usedCapacity * 10) / 10,
              dashboardUrl: `${serverEnv.ORIGIN}/modelhub`,
            },
          }).catch((err: unknown) => log.error({ err }, "Failed to send capacity warning notification"));
        }
        log.info({ usedPercent, totalCapacity, usedCapacity }, "Capacity warning notification sent");
      }
    } else {
      capacityWarningActive = false;
    }
  } catch (err) {
    log.error({ err }, "Failed to check capacity");
  }
}

// ── Weekly report ───────────────────────────────────────────────────

async function checkWeeklyReport() {
  try {
    const now = new Date();
    // Only fire on Monday between 8:00-8:59 UTC
    if (now.getUTCDay() !== 1 || now.getUTCHours() !== 8) return;

    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const [orgs, nodeResult] = await Promise.all([
      getDB().select({ id: organizationT.id, name: organizationT.name }).from(organizationT),
      // Count active nodes (instance-wide, same for all orgs)
      getDB().select({ count: count() }).from(aiNodeT).where(sql`
        ${aiNodeT.available} = true AND ${aiNodeT.deletedAt} IS NULL
      `),
    ]);
    const activeNodes = nodeResult[0]?.count ?? 0;

    for (const org of orgs) {
      // Count active deployments
      const [deploymentResult] = await getDB()
        .select({ count: count() })
        .from(modelDeploymentT)
        .where(sql`
          ${modelDeploymentT.organizationId} = ${org.id}
        AND
          ${modelDeploymentT.enabled} = true
        AND
          ${modelDeploymentT.deletedAt} IS NULL`);
      const deploymentCount = deploymentResult?.count ?? 0;

      // Count API calls this week
      const [callResult] = await getDB()
        .select({ count: count() })
        .from(apiCallT)
        .where(sql`${apiCallT.organizationId} = ${org.id} AND ${apiCallT.createdAt} >= ${oneWeekAgo}`);
      const totalApiCalls = callResult?.count ?? 0;

      // Top models by call count
      const topModelsRows = await getDB()
        .select({
          model: apiCallT.model,
          calls: count(),
        })
        .from(apiCallT)
        .where(sql`${apiCallT.organizationId} = ${org.id} AND ${apiCallT.createdAt} >= ${oneWeekAgo}`)
        .groupBy(apiCallT.model)
        .orderBy(sql`count(*) DESC`)
        .limit(5);

      const topModels = topModelsRows.map(r => ({ name: r.model, calls: r.calls }));

      const period = `${oneWeekAgo.toLocaleDateString("en-US", { month: "short", day: "numeric" })} to ${now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

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
  await checkDeploymentStatus();
  await checkNodeHealth();
  await checkCapacity();

  if (!initialized) {
    initialized = true;
    log.info("Notification scheduler initialized (first snapshot taken)");
  }
}

// ── Public API ──────────────────────────────────────────────────────

export async function startNotificationScheduler() {
  if (building) return;

  log.info("Starting notification scheduler");

  // Warmup: take initial snapshot after a brief delay
  await Bun.sleep(2_000);
  await runChecks();

  // Periodic checks (deployment status, node health, capacity)
  const checkInterval = setInterval(runChecks, CHECK_INTERVAL_MS);
  process.on("beforeExit", () => clearInterval(checkInterval));

  // Weekly report check (runs hourly, fires on Monday 8 AM UTC)
  const weeklyInterval = setInterval(checkWeeklyReport, WEEKLY_CHECK_INTERVAL_MS);
  process.on("beforeExit", () => clearInterval(weeklyInterval));
}
