import { inArray, modelDeploymentT, sql, modelInstallationT, aiNodeT, type ModelInstallation, type AiNode } from "common-db";
import { resolveOptimizeFor, settingsEqual } from "common-env";
import { getDB } from "$lib/server/db";
import { resolveSchedulable, type SchedulableModel } from "$lib/server/lib/models/model-catalog";
import { checkNodeCompatibility, type BlockedVersion, type ModelNodeRequirements, type NodeCapability, type Provider } from "common-env/model-catalog";
import { rootLogger } from "$lib/server/logging";
import { building } from "$app/environment";
import { maxVramGb } from "$lib/server/license";
import { config } from "$lib/server/config";
import { nodeIsLive } from "./node-liveness";
import { buildClusterState, chargeCapacity, poolCharge, rankServers, releaseInstallationFromState, resourcesOf, type ClusterState, type NewInstallation } from "./cluster-state";
import { ENGINE_SCHEDULERS } from "./engines";
import type { PlacementRequest } from "./engines/engine";
import type { Placement } from "./placement";
import { requirementsForDeployments, type ModelRequirementTable } from "./requirements";
import type { DeploymentStrategy } from "./strategy";

const log = rootLogger.child({ name: "orchestration.mod" })

// Builds the replica requirement table based on enabled deployments.
export async function assembleModelRequirementTable(): Promise<ModelRequirementTable> {
  const enabledDeployments = await getDB().select().from(modelDeploymentT).where(sql`
    ${modelDeploymentT.enabled}
  AND
    ${modelDeploymentT.deletedAt} IS NULL
  `);
  return requirementsForDeployments(enabledDeployments);
}

/** Trims installations that exceed required replica count; mutates state to free their capacity. */
export function collectExcessInstallations(requiredModels: ModelRequirementTable, state: ClusterState): string[] {
  const toUninstall: string[] = [];

  for (const [key, installs] of state.installationsByRequirement) {
    const required = requiredModels[key]?.replicas || 0;
    if (installs.length <= required) continue;

    const excess = installs.length - required;
    const removing = installs.slice(0, excess);
    for (const rem of removing) {
      toUninstall.push(rem.id);
      releaseInstallationFromState(state, rem);
    }
    state.installationsByRequirement.set(key, installs.slice(excess));
  }

  return toUninstall;
}

/** Collects installations whose settings have drifted; mutates state to free their capacity. */
export function collectDriftedInstallations(requiredModels: ModelRequirementTable, state: ClusterState): string[] {
  const toUninstall: string[] = [];

  for (const [key, installs] of state.installationsByRequirement) {
    const requirement = requiredModels[key];
    if (!requirement) {
      continue;
    }

    const kept: ModelInstallation[] = [];
    for (const install of installs) {
      if (settingsEqual(install.settings, requirement.settings)) {
        kept.push(install);
        continue;
      }
      toUninstall.push(install.id);
      releaseInstallationFromState(state, install);
    }
    state.installationsByRequirement.set(key, kept);
  }

  return toUninstall;
}

function nodeExcludesPlacement(
  nodeId: string,
  driver: Provider,
  candidate: Placement,
  state: ClusterState,
  pending: NewInstallation[],
): boolean {
  const { excludes } = ENGINE_SCHEDULERS[driver];
  const existing = state.installationsByServer.get(nodeId) ?? [];
  if (existing.some(inst => inst.driver === driver && excludes(inst, candidate))) {
    return true;
  }
  return pending.some(p => p.nodeId === nodeId && p.driver === driver && excludes(p, candidate));
}

/** What a model demands of a node, beyond the driver and the room to hold it. */
export type PlacementConstraints = {
  minVersion?: string;
  blockedVersions?: BlockedVersion[];
  requiredPlatforms?: string[];
  requiredFeatures?: string[];
};

/** Picks a node according to the configured strategy; skips nodes where the engine's node rule excludes the placement. */
export function findServerForModel(
  placement: Placement,
  driver: Provider,
  need: Omit<PlacementRequest, "strategy">,
  state: ClusterState,
  pending: NewInstallation[],
  strategy: DeploymentStrategy,
  constraints: PlacementConstraints = {},
): string | null {
  for (const server of rankServers(strategy, state)) {
    const cap = state.serverCapacity.get(server.id);
    if (!cap) continue;

    if (nodeExcludesPlacement(server.id, driver, placement, state, pending)) {
      continue;
    }

    const node = resourcesOf(state, server.id);
    const slot = ENGINE_SCHEDULERS[driver].placeOnNode(node, { ...need, strategy });
    if (!slot) {
      continue;
    }

    const req: ModelNodeRequirements = {
      driver, capacityGb: poolCharge(node, slot),
      minVersion: constraints.minVersion,
      blockedVersions: constraints.blockedVersions,
      requiredPlatforms: constraints.requiredPlatforms ?? [],
      requiredFeatures: constraints.requiredFeatures,
    };
    const nodeCap: NodeCapability = {
      free: cap.total - cap.used,
      driverVersions: server.driverVersions,
      driverFeatures: server.driverFeatures ?? {},
      gpus: server.gpus,
    };

    if (checkNodeCompatibility(nodeCap, req) !== null) continue;

    return server.id;
  }
  return null;
}

function allocatePort(driver: Provider, nodeId: string, state: ClusterState, pending: NewInstallation[]): number {
  const usedPorts = new Set([
    ...(state.installationsByServer.get(nodeId) ?? []).map(i => i.port),
    ...pending.filter(p => p.nodeId === nodeId).map(p => p.port),
  ]);
  return ENGINE_SCHEDULERS[driver].port(usedPorts);
}

// The license counts GPU memory, so a unified node's host part stays out of it.
function totalVramUsed(state: ClusterState): number {
  let used = 0;
  for (const installs of state.installationsByServer.values()) {
    for (const install of installs) {
      used += install.estCapacity;
    }
  }
  return used;
}

export type ShortfallReason = "catalog_unavailable" | "not_found" | "no_compatible_node" | "no_capacity" | "license_limit";

export type Shortfall = { specifier: string; missing: number; reason: ShortfallReason; constraints?: PlacementConstraints & { driver: Provider } };

export type InstallationPlan = { toInstall: NewInstallation[]; shortfalls: Shortfall[] };

function anyNodeCouldServe(state: ClusterState, driver: Provider, constraints: PlacementConstraints): boolean {
  return state.availableServers.some((server) => checkNodeCompatibility(
    { free: Infinity, driverVersions: server.driverVersions, driverFeatures: server.driverFeatures ?? {}, gpus: server.gpus },
    { driver, capacityGb: 0, ...constraints, requiredPlatforms: constraints.requiredPlatforms ?? [] },
  ) === null);
}

/** Plans installations needed to satisfy replica requirements that aren't yet met,
 * stopping a replica loop early when the next install would exceed the license VRAM cap. */
async function planNewInstallations(
  requiredModels: ModelRequirementTable,
  state: ClusterState,
  licenseVramLimit: number,
  strategy: DeploymentStrategy,
): Promise<InstallationPlan> {
  const toInstall: NewInstallation[] = [];
  const shortfalls: Shortfall[] = [];
  let usedVram = totalVramUsed(state);

  for (const [key, requirement] of Object.entries(requiredModels)) {
    const { specifier } = requirement;
    const current = (state.installationsByRequirement.get(key) || []).length;
    if (current >= requirement.replicas) continue;

    const resolution = await resolveSchedulable(requirement.specifier, requirement.preferredDriver);
    if (resolution.status === "unavailable") {
      log.warn({ specifier: requirement.specifier, error: resolution.error },
        "Info server unreachable; skipping installation planning for this sync cycle");
      shortfalls.push({ specifier, missing: requirement.replicas - current, reason: "catalog_unavailable" });
      continue;
    }
    if (resolution.status === "not_found") {
      log.warn({ specifier: requirement.specifier },
        "Model not found in catalog; installations cannot be scheduled. " +
        "If this model has been intentionally removed, disable or delete the deployment.");
      shortfalls.push({ specifier, missing: requirement.replicas - current, reason: "not_found" });
      continue;
    }
    const modelInfo = resolution.model;

    const { driver, minVersion, blockedVersions, requiredPlatforms, requiredFeatures } = modelInfo;
    const needed = requirement.replicas - current;

    const effectiveKvCache = Math.max(requirement.kvCacheSize ?? 0, modelInfo.minKvCache);
    const need = { model: modelInfo, kvCacheGb: effectiveKvCache, goal: resolveOptimizeFor(requirement.settings) };

    const constraints = { minVersion, blockedVersions, requiredPlatforms, requiredFeatures };
    for (let i = 0; i < needed; i++) {
      const nodeId = findServerForModel({ deploymentId: requirement.deploymentId, specifier }, driver, need, state, toInstall, strategy, constraints);
      const slot = nodeId ? ENGINE_SCHEDULERS[driver].placeOnNode(resourcesOf(state, nodeId), { ...need, strategy }) : undefined;
      if (!nodeId || !slot) {
        log.warn({ specifier: requirement.specifier }, "No server with enough capacity for additional replica");
        const reason = anyNodeCouldServe(state, driver, constraints) ? "no_capacity" : "no_compatible_node";
        shortfalls.push({ specifier, missing: needed - i, reason, constraints: { ...constraints, driver } });
        break;
      }

      if (usedVram + slot.estCapacity > licenseVramLimit) {
        log.warn(
          { specifier: requirement.specifier, usedVram, licenseVramLimit, additional: slot.estCapacity },
          "License VRAM limit reached; skipping additional replica",
        );
        shortfalls.push({ specifier, missing: needed - i, reason: "license_limit" });
        break;
      }

      const installation: NewInstallation = {
        nodeId,
        deploymentId: requirement.deploymentId,
        specifier: requirement.specifier,
        estCapacity: slot.estCapacity,
        kvCacheCapacity: effectiveKvCache,
        hostCapacity: slot.hostCapacity,
        maxNumSeqs: slot.maxNumSeqs,
        driver,
        port: allocatePort(driver, nodeId, state, toInstall),
        settings: requirement.settings,
        gpuIds: slot.gpuIds,
      };
      toInstall.push(installation);

      chargeCapacity(state, installation, slot);
      usedVram += slot.estCapacity;
    }
  }

  return { toInstall, shortfalls };
}

type ModelLookup = (specifier: string, driver: Provider) => Promise<SchedulableModel | null>;

/** Whether some available node could actually take over this installation, checked the same way
 * real placement is: driver, capacity, driver version, GPU platform, and required features
 * (`findServerForModel`, the same function `planNewInstallations` uses). Of the installations
 * sitting on now-unavailable nodes, only these are soft-deleted; the rest are left alone, since
 * with few nodes in a cluster, a node going offline is far more likely to be transient than a
 * real removal, and their installation rows need to survive so the models are still considered
 * desired once the node returns. */
async function hasReassignmentTarget(install: ModelInstallation, state: ClusterState, lookupModel: ModelLookup): Promise<boolean> {
  const modelInfo = await lookupModel(install.specifier, install.driver as Provider);
  if (!modelInfo) return false;

  const need = { model: modelInfo, kvCacheGb: install.kvCacheCapacity, goal: resolveOptimizeFor(install.settings) };
  const nodeId = findServerForModel(install, install.driver, need, state, [], "first-fit", modelInfo);
  return nodeId !== null;
}

export async function collectReassignableOrphans(
  orphanedCandidates: ModelInstallation[],
  state: ClusterState,
  lookupModel: ModelLookup,
): Promise<ModelInstallation[]> {
  const reassignable = await Promise.all(orphanedCandidates.map(install => hasReassignmentTarget(install, state, lookupModel)));
  return orphanedCandidates.filter((_, i) => reassignable[i]);
}

export async function chargeUnchargedInstallations(
  installations: ModelInstallation[],
  servers: AiNode[],
  lookupModel: ModelLookup,
): Promise<ModelInstallation[]> {
  const idle = buildClusterState([], servers);
  return Promise.all(installations.map(async (install) => {
    if (install.hostCapacity !== null) {
      return install;
    }
    const model = await lookupModel(install.specifier, install.driver);
    if (!model) {
      return install;
    }
    const cards = Math.max(install.gpuIds.length, 1);
    const charge = ENGINE_SCHEDULERS[install.driver].charge(resourcesOf(idle, install.nodeId), { model, kvCacheGb: install.kvCacheCapacity }, cards);
    if (!charge) {
      log.warn({ installationId: install.id, specifier: install.specifier, cards }, "Installation runs on a split its catalog entry no longer allows; keeping its old charge");
    }
    return { ...install, ...(charge ?? { hostCapacity: 0 }) };
  }));
}

async function persistCharges(before: ModelInstallation[], after: ModelInstallation[]): Promise<void> {
  const charged = after.filter((install, index) => before[index]!.hostCapacity === null && install.hostCapacity !== null);
  await Promise.all(charged.map((install) => getDB()
    .update(modelInstallationT)
    .set({ estCapacity: install.estCapacity, hostCapacity: install.hostCapacity, maxNumSeqs: install.maxNumSeqs })
    .where(sql`${modelInstallationT.id} = ${install.id}`)));
}

export type PlannedReplica = { specifier: string; machineName: string; cards: number; gpuGb: number; hostGb: number };

export type PlacementPreview = { replicas: PlannedReplica[]; shortfalls: Shortfall[] };

const lookupSchedulable: ModelLookup = async (specifier, driver) => {
  const resolution = await resolveSchedulable(specifier, driver);
  return resolution.status === "found" ? resolution.model : null;
};

// Plans a deployment draft on the cluster as it is, without the installations the deployment
// already has, and writes nothing.
export async function previewPlacement(requirements: ModelRequirementTable, replacedDeploymentId?: string): Promise<PlacementPreview> {
  const [existing, servers]: [ModelInstallation[], AiNode[]] = await Promise.all([
    getDB().select().from(modelInstallationT).where(sql`${modelInstallationT.deletedAt} IS NULL`),
    getDB().select().from(aiNodeT).where(nodeIsLive),
  ]);
  const liveIds = new Set(servers.map((server) => server.id));
  const others = existing.filter((install) => liveIds.has(install.nodeId) && install.deploymentId !== replacedDeploymentId);
  const state = buildClusterState(await chargeUnchargedInstallations(others, servers, lookupSchedulable), servers);
  const { toInstall, shortfalls } = await planNewInstallations(requirements, state, maxVramGb(), config.compute.deploymentStrategy());
  const machineName = (nodeId: string) => {
    const server = servers.find((candidate) => candidate.id === nodeId);
    return server?.machineName ?? server?.host ?? nodeId;
  };
  return {
    replicas: toInstall.map((install) => ({
      specifier: install.specifier,
      machineName: machineName(install.nodeId),
      cards: Math.max(install.gpuIds?.length ?? 0, 1),
      gpuGb: install.estCapacity,
      hostGb: install.hostCapacity ?? 0,
    })),
    shortfalls,
  };
}

async function applyChanges(toUninstall: string[], toInstall: NewInstallation[]) {
  if (toUninstall.length > 0) {
    await getDB().update(modelInstallationT).set({ deletedAt: new Date() }).where(inArray(modelInstallationT.id, toUninstall));
    log.info({ toUninstall }, `Uninstalled ${toUninstall.length} models`);
  }
  if (toInstall.length > 0) {
    await getDB().insert(modelInstallationT).values(toInstall);
    log.info({ toInstall }, `Installed ${toInstall.length} models`);
  }
}

async function runSyncDeployedModels() {
  const requiredModels = await assembleModelRequirementTable();
  const [existing, availableServers]: [ModelInstallation[], AiNode[]] = await Promise.all([
    getDB().select().from(modelInstallationT).where(sql`${modelInstallationT.deletedAt} IS NULL`),
    getDB().select().from(aiNodeT).where(nodeIsLive),
  ]);

  const availableServerIds = new Set(availableServers.map(s => s.id));
  const orphanedCandidates = existing.filter(i => !availableServerIds.has(i.nodeId));
  const active = existing.filter(i => availableServerIds.has(i.nodeId));

  const charged = await chargeUnchargedInstallations(active, availableServers, lookupSchedulable);
  await persistCharges(active, charged);

  const state = buildClusterState(charged, availableServers);
  const orphaned = await collectReassignableOrphans(orphanedCandidates, state, lookupSchedulable);
  const keptOffline = orphanedCandidates.length - orphaned.length;

  log.debug(
    { requiredModels, installedModels: existing.length, availableServers: availableServers.length, orphaned: orphaned.length, keptOffline },
    "Syncing deployed models",
  );

  const toUninstall = [
    ...orphaned.map(i => i.id),
    ...collectExcessInstallations(requiredModels, state),
    ...collectDriftedInstallations(requiredModels, state),
  ];
  const { toInstall } = await planNewInstallations(requiredModels, state, maxVramGb(), config.compute.deploymentStrategy());
  await applyChanges(toUninstall, toInstall);
}

let activeSync: Promise<void> | null = null;
let rerunRequested = false;

/** Single-flight + trailing rerun: prevents two parallel runs from picking the same (node, port). */
export function syncDeployedModels(): Promise<void> {
  if (activeSync) {
    rerunRequested = true;
    return activeSync;
  }
  activeSync = (async () => {
    try {
      await runSyncDeployedModels();
      while (rerunRequested) {
        rerunRequested = false;
        await runSyncDeployedModels();
      }
    } finally {
      activeSync = null;
      rerunRequested = false;
    }
  })();
  return activeSync;
}

const SYNC_WARMUP_MS = 1_000;
const SYNC_INTERVAL_MS = 5 * 60_000;

/** Starts the background deployment sync loop. */
export async function startDeploymentSyncService() {
  log.info("Starting deployment sync service")
  if (!building) {
    await Bun.sleep(SYNC_WARMUP_MS);
    await syncDeployedModels();
    const interval = setInterval(syncDeployedModels, SYNC_INTERVAL_MS);
    process.on("beforeExit", () => clearInterval(interval));
  }
}
