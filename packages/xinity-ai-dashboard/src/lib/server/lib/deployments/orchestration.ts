import { inArray, modelDeploymentT, sql, modelInstallationT, aiNodeT, type ModelInstallation, type AiNode } from "common-db";
import { settingsEqual } from "common-env";
import { getDB } from "$lib/server/db";
import { resolveSchedulable, type SchedulableModel } from "$lib/server/lib/models/model-catalog";
import { checkNodeCompatibility, type BlockedVersion, type ModelNodeRequirements, type NodeCapability, type Provider } from "common-env/model-catalog";
import { rootLogger } from "$lib/server/logging";
import { building } from "$app/environment";
import { maxVramGb } from "$lib/server/license";
import { config } from "$lib/server/config";
import { nodeIsLive } from "./node-liveness";
import { buildClusterState, cardsOf, chargeCapacity, rankServers, releaseInstallationFromState, type ClusterState, type NewInstallation } from "./cluster-state";
import { ENGINE_SCHEDULERS } from "./engines";
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
  weight: number,
  state: ClusterState,
  pending: NewInstallation[],
  strategy: DeploymentStrategy,
  constraints: PlacementConstraints = {},
): string | null {
  const req: ModelNodeRequirements = {
    driver, capacityGb: weight,
    minVersion: constraints.minVersion,
    blockedVersions: constraints.blockedVersions,
    requiredPlatforms: constraints.requiredPlatforms ?? [],
    requiredFeatures: constraints.requiredFeatures,
  };

  for (const server of rankServers(strategy, state)) {
    const cap = state.serverCapacity.get(server.id);
    if (!cap) continue;

    if (nodeExcludesPlacement(server.id, driver, placement, state, pending)) {
      continue;
    }

    const nodeCap: NodeCapability = {
      free: cap.total - cap.used,
      driverVersions: server.driverVersions,
      driverFeatures: server.driverFeatures ?? {},
      gpus: server.gpus,
    };

    if (checkNodeCompatibility(nodeCap, req) !== null) continue;

    if (!ENGINE_SCHEDULERS[driver].placeOnNode(cardsOf(state, server.id), { capacityGb: weight, strategy })) {
      continue;
    }

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

function totalVramUsed(state: ClusterState): number {
  let used = 0;
  for (const cap of state.serverCapacity.values()) {
    used += cap.used;
  }
  return used;
}

/** Plans installations needed to satisfy replica requirements that aren't yet met,
 * stopping a replica loop early when the next install would exceed the license VRAM cap. */
async function planNewInstallations(
  requiredModels: ModelRequirementTable,
  state: ClusterState,
  licenseVramLimit: number,
  strategy: DeploymentStrategy,
): Promise<NewInstallation[]> {
  const toInstall: NewInstallation[] = [];
  let usedVram = totalVramUsed(state);

  for (const [key, requirement] of Object.entries(requiredModels)) {
    const { specifier } = requirement;
    const current = (state.installationsByRequirement.get(key) || []).length;
    if (current >= requirement.replicas) continue;

    const resolution = await resolveSchedulable(requirement.specifier, requirement.preferredDriver);
    if (resolution.status === "unavailable") {
      log.warn({ specifier: requirement.specifier, error: resolution.error },
        "Info server unreachable; skipping installation planning for this sync cycle");
      continue;
    }
    if (resolution.status === "not_found") {
      log.warn({ specifier: requirement.specifier },
        "Model not found in catalog; installations cannot be scheduled. " +
        "If this model has been intentionally removed, disable or delete the deployment.");
      continue;
    }
    const modelInfo = resolution.model;

    const { driver, minVersion, blockedVersions, requiredPlatforms, requiredFeatures } = modelInfo;
    const needed = requirement.replicas - current;

    const effectiveKvCache = Math.max(requirement.kvCacheSize ?? 0, modelInfo.minKvCache);
    const totalCapacity = modelInfo.weight + effectiveKvCache;

    for (let i = 0; i < needed; i++) {
      if (usedVram + totalCapacity > licenseVramLimit) {
        log.warn(
          { specifier: requirement.specifier, usedVram, licenseVramLimit, additional: totalCapacity },
          "License VRAM limit reached; skipping additional replica",
        );
        break;
      }

      const nodeId = findServerForModel({ deploymentId: requirement.deploymentId, specifier }, driver, totalCapacity, state, toInstall, strategy,
        { minVersion, blockedVersions, requiredPlatforms, requiredFeatures });
      const slot = nodeId ? ENGINE_SCHEDULERS[driver].placeOnNode(cardsOf(state, nodeId), { capacityGb: totalCapacity, strategy }) : undefined;
      if (!nodeId || !slot) {
        log.warn({ specifier: requirement.specifier }, "No server with enough capacity for additional replica");
        break;
      }

      const installation: NewInstallation = {
        nodeId,
        deploymentId: requirement.deploymentId,
        specifier: requirement.specifier,
        estCapacity: slot.estCapacity,
        kvCacheCapacity: effectiveKvCache,
        driver,
        port: allocatePort(driver, nodeId, state, toInstall),
        settings: requirement.settings,
        gpuUuids: slot.gpuUuids,
      };
      toInstall.push(installation);

      chargeCapacity(state, installation, slot.estCapacity);
      usedVram += slot.estCapacity;
    }
  }

  return toInstall;
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

  const nodeId = findServerForModel(
    install, install.driver, install.estCapacity, state, [], "first-fit",
    modelInfo,
  );
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

  const state = buildClusterState(active, availableServers);
  const orphaned = await collectReassignableOrphans(orphanedCandidates, state, async (specifier, driver) => {
    const resolution = await resolveSchedulable(specifier, driver);
    return resolution.status === "found" ? resolution.model : null;
  });
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
  const toInstall = await planNewInstallations(requiredModels, state, maxVramGb(), config.compute.deploymentStrategy());
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
