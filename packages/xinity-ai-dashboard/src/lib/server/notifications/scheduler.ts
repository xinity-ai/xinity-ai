import {
  sql,
  modelDeploymentT,
  modelInstallationT,
  modelInstallationStateT,
  aiNodeT,
  usageEventT,
  organizationT,
  count,
  deploymentMatchesInstallation,
  type SQL,
  nodeIsLive,
  installationOnLiveNode,
  stateOfInstallation,
} from "common-db";
import { config } from "$lib/server/config";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { building } from "$app/env";
import { notifyOrgMembers } from "./notification.service";
import { NotificationType } from "./events";
import { type DeploymentPhase, type DisplayPhase, type ReplicaMember, foldDeployment, foldReplicas, toDisplayPhase } from "$lib/server/lib/deployments/deployment-phase";
import type { InstallationGroup } from "common-env";

const log = rootLogger.child({ name: "notification.scheduler" });

const CHECK_INTERVAL_MS = 5 * 60_000; // 5 minutes
const WEEKLY_CHECK_INTERVAL_MS = 60 * 60_000; // 1 hour
const WARMUP_DELAY_MS = 2_000;
const CAPACITY_WARNING_THRESHOLD = 0.8; // 80%
const MODELHUB_URL = `${config.origin}/modelhub/`;

// ── In-memory state ─────────────────────────────────────────────────

/** Lives for one scheduler run, so re-enabling notifications starts from a fresh snapshot. */
type SchedulerState = {
  deploymentPhases: Map<string, DisplayPhase>;
  nodeAvailability: Map<string, boolean>;
  /** False until the first snapshot is taken, which sends no notifications. */
  initialized: boolean;
  /** Reset when capacity drops below the threshold. */
  capacityWarningActive: boolean;
};

function createSchedulerState(): SchedulerState {
  return {
    deploymentPhases: new Map(),
    nodeAvailability: new Map(),
    initialized: false,
    capacityWarningActive: false,
  };
}

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

export type DeploymentInfo = {
  phase: DisplayPhase;
  orgId: string;
  orgName: string;
  name: string;
  model: string;
  error: string | null;
  /** Replicas placed, which can fall short of `desiredReplicas`. */
  observedReplicas: number;
  desiredReplicas: number;
};

export type DeploymentPhaseRow = {
  deploymentId: string;
  deploymentName: string;
  organizationId: string;
  orgName: string | null;
  publicSpecifier: string;
  desiredReplicas: number;
  installationId: string | null;
  installationGroup: InstallationGroup | null;
  liveNodeId: string | null;
  lifecycleState: string | null;
  errorMessage: string | null;
};

/**
 * Folds the installation join into one aggregate per deployment.
 *
 * A deployment with no installations still yields a row with a null `installationId`, so the
 * observed count keys off that column rather than the row count.
 */
export function foldDeploymentPhaseRows(rows: DeploymentPhaseRow[]): Map<string, DeploymentInfo> {
  const deployments = new Map<string, { first: DeploymentPhaseRow; orgName: string; members: ReplicaMember[] }>();

  for (const row of rows) {
    const deployment = deployments.get(row.deploymentId) ?? { first: row, orgName: "", members: [] };
    deployment.orgName = row.orgName ?? deployment.orgName;
    if (row.installationId !== null && row.liveNodeId !== null) {
      deployment.members.push({
        installationId: row.installationId,
        group: row.installationGroup,
        phase: (row.lifecycleState as DeploymentPhase | null) ?? "scheduling",
        progress: null,
        error: row.errorMessage,
        failureLogs: null,
      });
    }
    deployments.set(row.deploymentId, deployment);
  }

  const result = new Map<string, DeploymentInfo>();
  for (const [id, { first, orgName, members }] of deployments) {
    const replicas = foldReplicas(members);
    const info = foldDeployment(replicas.map(({ info }) => info));
    result.set(id, {
      phase: info ? toDisplayPhase(info) : "pending",
      orgId: first.organizationId,
      orgName,
      name: first.deploymentName,
      model: first.publicSpecifier,
      error: info?.error ?? null,
      observedReplicas: replicas.length,
      desiredReplicas: first.desiredReplicas,
    });
  }
  return result;
}

async function getDeploymentPhases(): Promise<Map<string, DeploymentInfo>> {
  const rows = await getDB()
    .select({
      deploymentId: modelDeploymentT.id,
      deploymentName: modelDeploymentT.name,
      organizationId: modelDeploymentT.organizationId,
      orgName: organizationT.name,
      publicSpecifier: modelDeploymentT.publicSpecifier,
      desiredReplicas: modelDeploymentT.replicas,
      installationId: modelInstallationT.id,
      installationGroup: modelInstallationT.group,
      liveNodeId: aiNodeT.id,
      lifecycleState: modelInstallationStateT.lifecycleState,
      errorMessage: modelInstallationStateT.errorMessage,
    })
    .from(modelDeploymentT)
    .where(sql`
      ${modelDeploymentT.enabled}
    AND
      ${modelDeploymentT.deletedAt} IS NULL
    `)
    .leftJoin(organizationT, sql`${organizationT.id} = ${modelDeploymentT.organizationId}`)
    .leftJoin(modelInstallationT, sql`
      ${deploymentMatchesInstallation}
    AND
      ${modelInstallationT.deletedAt} IS NULL
    `)
    .leftJoin(modelInstallationStateT, stateOfInstallation)
    .leftJoin(aiNodeT, installationOnLiveNode);

  return foldDeploymentPhaseRows(rows);
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
      publicSpecifier: info.model,
      orgName: info.orgName,
      dashboardUrl: MODELHUB_URL,
      ...extraData,
    },
  }).catch((err: unknown) => log.error({ err }, `Failed to send deployment ${label} notification`));
  log.info({ deploymentId, name: info.name }, `Deployment ${label} notification sent`);
}

async function checkDeploymentStatus(state: SchedulerState) {
  try {
    const currentPhases = await getDeploymentPhases();

    for (const [deploymentId, info] of currentPhases) {
      const previousPhase = state.deploymentPhases.get(deploymentId);
      state.deploymentPhases.set(deploymentId, info.phase);

      if (!state.initialized || previousPhase === undefined) continue;
      if (previousPhase === info.phase) continue;

      if (info.phase === "ready") {
        dispatchDeploymentPhaseNotification(deploymentId, info, NotificationType.deployment_ready, "ready", {
          observedReplicas: info.observedReplicas,
          desiredReplicas: info.desiredReplicas,
        });
      } else if (info.phase === "failed") {
        dispatchDeploymentPhaseNotification(deploymentId, info, NotificationType.deployment_failed, "failed", {
          errorMessage: info.error ?? "An unknown error occurred during installation",
        });
      }
    }

    pruneStaleCacheEntries(state.deploymentPhases, currentPhases.keys());
  } catch (err) {
    log.error({ err }, "Failed to check deployment status");
  }
}

// ── Node health check ───────────────────────────────────────────────

async function checkNodeHealth(state: SchedulerState) {
  try {
    const nodes = await getDB()
      .select({ id: aiNodeT.id, host: aiNodeT.host, port: aiNodeT.port, available: aiNodeT.available })
      .from(aiNodeT)
      .where(sql`${aiNodeT.deletedAt} IS NULL`);

    for (const node of nodes) {
      const previousAvailable = state.nodeAvailability.get(node.id);
      state.nodeAvailability.set(node.id, node.available);

      if (!state.initialized || previousAvailable === undefined) continue;
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

    pruneStaleCacheEntries(state.nodeAvailability, nodes.map(n => n.id));
  } catch (err) {
    log.error({ err }, "Failed to check node health");
  }
}

// ── Capacity check ──────────────────────────────────────────────────

async function checkCapacity(state: SchedulerState) {
  try {
    const [nodes, installations] = await Promise.all([
      getDB()
        .select({ estCapacity: aiNodeT.estCapacity })
        .from(aiNodeT)
        .where(nodeIsLive),
      getDB()
        .select({ estCapacity: modelInstallationT.estCapacity })
        .from(modelInstallationT)
        .innerJoin(aiNodeT, installationOnLiveNode)
        .where(sql`${modelInstallationT.deletedAt} IS NULL`),
    ]);

    const totalCapacity = nodes.reduce((sum, n) => sum + n.estCapacity, 0);
    if (totalCapacity === 0) return;

    const usedCapacity = installations.reduce((sum, inst) => sum + inst.estCapacity, 0);
    const usedRatio = usedCapacity / totalCapacity;

    if (usedRatio < CAPACITY_WARNING_THRESHOLD) {
      state.capacityWarningActive = false;
      return;
    }
    if (state.capacityWarningActive) {
      return;
    }

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
    state.capacityWarningActive = true;
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
    .where(sql`
      ${modelDeploymentT.organizationId} = ${orgId}
    AND
      ${modelDeploymentT.enabled}
    AND
      ${modelDeploymentT.deletedAt} IS NULL
    `);
  return row?.count ?? 0;
}

/** `logged AND success` reproduces what the retired `api_call` table used to hold. */
function loggedSince(orgId: string, since: Date): SQL {
  return sql`
    ${usageEventT.organizationId} = ${orgId}
  AND
    ${usageEventT.createdAt} >= ${since}
  AND
    ${usageEventT.logged}
  AND
    ${usageEventT.success}
  `;
}

async function countApiCallsSince(orgId: string, since: Date): Promise<number> {
  const [row] = await getDB()
    .select({ count: count() })
    .from(usageEventT)
    .where(loggedSince(orgId, since));
  return row?.count ?? 0;
}

async function topModelsByCallsSince(orgId: string, since: Date, limit = 5): Promise<Array<{ name: string; calls: number }>> {
  return await getDB()
    .select({ name: usageEventT.model, calls: count() })
    .from(usageEventT)
    .where(loggedSince(orgId, since))
    .groupBy(usageEventT.model)
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
      getDB().select({ count: count() }).from(aiNodeT).where(nodeIsLive),
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
          dashboardUrl: config.origin,
        },
      }).catch((err: unknown) => log.error({ err }, "Failed to send weekly report notification"));

      log.info({ orgId: org.id, orgName: org.name }, "Weekly report sent");
    }
  } catch (err) {
    log.error({ err }, "Failed to send weekly reports");
  }
}

// ── Combined check ──────────────────────────────────────────────────

async function runChecks(state: SchedulerState) {
  await Promise.all([checkDeploymentStatus(state), checkNodeHealth(state), checkCapacity(state)]);

  if (!state.initialized) {
    state.initialized = true;
    log.info("Notification scheduler initialized (first snapshot taken)");
  }
}

// ── Public API ──────────────────────────────────────────────────────

/** Returns a stop, because the setting that starts this can be turned off while the process runs. */
export function startNotificationScheduler(): () => void {
  if (building) {
    return () => {};
  }

  log.info("Starting notification scheduler");

  const state = createSchedulerState();
  const handles: Timer[] = [];
  let stopped = false;

  void (async () => {
    await Bun.sleep(WARMUP_DELAY_MS);
    if (stopped) {
      return;
    }
    await runChecks(state);
    if (stopped) {
      return;
    }
    handles.push(setInterval(() => runChecks(state), CHECK_INTERVAL_MS));
    // Weekly report check runs hourly; checkWeeklyReport gates on Monday 8 AM UTC.
    handles.push(setInterval(checkWeeklyReport, WEEKLY_CHECK_INTERVAL_MS));
  })();

  return () => {
    stopped = true;
    for (const handle of handles) {
      clearInterval(handle);
    }
    handles.length = 0;
    log.info("Stopped notification scheduler");
  };
}
