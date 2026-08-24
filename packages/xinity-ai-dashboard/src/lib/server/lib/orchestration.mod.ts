import { inArray, modelDeploymentT, sql, calcCanaryProgress, modelInstallationT, aiNodeT, mergeSettings, settingsEqual, type DeploymentSettings, type ModelInstallation, type AiNode, type InferInsertModel } from "common-db";
import { getDB } from "../db";
import { resolveSchedulable, type SchedulableModel } from "../model-catalog";
import { checkNodeCompatibility, type BlockedVersion, type ModelNodeRequirements, type NodeCapability, type Provider } from "xinity-infoserver";
import { rootLogger } from "../logging";
import { building } from "$app/environment";
import { maxVramGb } from "$lib/server/license";
import { serverEnv } from "$lib/server/serverenv";

const log = rootLogger.child({ name: "orchestration.mod" })

const OLLAMA_PORT = 11434;
const VLLM_PORT_BASE = 11435;

type NewInstallation = InferInsertModel<typeof modelInstallationT>;

/** Mutable tracking state built from current DB contents. */
type ClusterState = {
  installationsByModel: Map<string, ModelInstallation[]>;
  installationsByServer: Map<string, ModelInstallation[]>;
  serverCapacity: Map<string, { total: number; used: number }>;
  availableServers: AiNode[];
}

export type ModelRequirement = { specifier: string; replicas: number; kvCacheSize: number | null; preferredDriver: Provider | null; settings: DeploymentSettings };
export type ModelRequirementTable = Record<string, ModelRequirement>;

export type DeploymentStrategy = "first-fit" | "balanced" | "bin-pack" | "proportional";

/** Returns availableServers ordered by the given strategy's preference.
 * Re-evaluated per placement so spread strategies see updated `used` after each replica. */
export function rankServers(strategy: DeploymentStrategy, state: ClusterState): AiNode[] {
  const free = (s: AiNode) => {
    const cap = state.serverCapacity.get(s.id);
    return cap ? cap.total - cap.used : 0;
  };
  const ratio = (s: AiNode) => {
    const cap = state.serverCapacity.get(s.id);
    return cap && cap.total > 0 ? cap.used / cap.total : 1;
  };
  const servers = [...state.availableServers];
  switch (strategy) {
    case "first-fit":    return servers;
    case "balanced":     return servers.sort((a, b) => free(b) - free(a));
    case "bin-pack":     return servers.sort((a, b) => free(a) - free(b));
    case "proportional": return servers.sort((a, b) => ratio(a) - ratio(b));
  }
}

export function mergeRequirementsBySpecifier(entries: ModelRequirement[]): ModelRequirementTable {
  return entries.reduce((agg, entry) => {
    const existing = agg[entry.specifier];
    if (!existing) {
      agg[entry.specifier] = entry;
      return agg;
    }
    if (entry.replicas > existing.replicas) existing.replicas = entry.replicas;
    if (entry.kvCacheSize != null && (existing.kvCacheSize == null || entry.kvCacheSize > existing.kvCacheSize)) {
      existing.kvCacheSize = entry.kvCacheSize;
    }
    existing.settings = mergeSettings(existing.settings, entry.settings);
    return agg;
  }, {} as ModelRequirementTable);
}

/** Builds the replica requirement table based on enabled deployments. */
export async function assembleModelRequirementTable(): Promise<ModelRequirementTable> {
  const enabledDeployments = await getDB().select().from(modelDeploymentT).where(sql`
    ${modelDeploymentT.enabled}
  AND
    ${modelDeploymentT.deletedAt} IS NULL
  `);
  const models = enabledDeployments.flatMap((deployment): ModelRequirement[] => {
    const progress = calcCanaryProgress(deployment);
    const earlySpecifier = deployment.earlySpecifier;
    const driver = deployment.preferredDriver;
    const isNotCanary = progress === 100 || !earlySpecifier;
    if (isNotCanary) {
      return [requirementFor(deployment.specifier, deployment.replicas, deployment.kvCacheSize, driver, deployment.settings)];
    }
    return [
      requirementFor(deployment.specifier, Math.ceil(deployment.replicas * (progress / 100)), deployment.kvCacheSize, driver, deployment.settings),
      requirementFor(earlySpecifier!, Math.ceil(deployment.replicas * ((100 - progress) / 100)), deployment.earlyKvCacheSize, driver, deployment.settings),
    ];
  });
  return mergeRequirementsBySpecifier(models);
}

function requirementFor(
  specifier: string,
  replicas: number,
  kvCacheSize: number | null,
  preferredDriver: Provider | null,
  settings: DeploymentSettings,
): ModelRequirement {
  return { specifier, replicas, kvCacheSize, preferredDriver, settings };
}

export function buildClusterState(existing: ModelInstallation[], availableServers: AiNode[]): ClusterState {
  const installationsByModel = new Map<string, ModelInstallation[]>();
  const installationsByServer = new Map<string, ModelInstallation[]>();
  const serverCapacity = new Map<string, { total: number; used: number }>();

  for (const server of availableServers) {
    serverCapacity.set(server.id, { total: server.estCapacity, used: 0 });
    installationsByServer.set(server.id, []);
  }

  for (const install of existing) {
    const modelInstalls = installationsByModel.get(install.specifier) || [];
    modelInstalls.push(install);
    installationsByModel.set(install.specifier, modelInstalls);

    const serverInstalls = installationsByServer.get(install.nodeId);
    if (serverInstalls) {
      serverInstalls.push(install);
      const cap = serverCapacity.get(install.nodeId);
      if (cap) cap.used += install.estCapacity;
    }
  }

  return { installationsByModel, installationsByServer, serverCapacity, availableServers };
}

function releaseInstallationFromState(state: ClusterState, installation: ModelInstallation): void {
  const cap = state.serverCapacity.get(installation.nodeId);
  if (cap) cap.used -= installation.estCapacity;

  const serverInstalls = state.installationsByServer.get(installation.nodeId);
  if (serverInstalls) {
    const idx = serverInstalls.findIndex(i => i.id === installation.id);
    if (idx !== -1) serverInstalls.splice(idx, 1);
  }
}

/** Trims installations that exceed required replica count; mutates state to free their capacity. */
export function collectExcessInstallations(requiredModels: ModelRequirementTable, state: ClusterState): string[] {
  const toUninstall: string[] = [];

  for (const [model, installs] of state.installationsByModel) {
    const required = requiredModels[model]?.replicas || 0;
    if (installs.length <= required) continue;

    const excess = installs.length - required;
    const removing = installs.slice(0, excess);
    for (const rem of removing) {
      toUninstall.push(rem.id);
      releaseInstallationFromState(state, rem);
    }
    state.installationsByModel.set(model, installs.slice(excess));
  }

  return toUninstall;
}

/** Collects installations whose settings have drifted; mutates state to free their capacity. */
export function collectDriftedInstallations(requiredModels: ModelRequirementTable, state: ClusterState): string[] {
  const toUninstall: string[] = [];

  for (const [model, installs] of state.installationsByModel) {
    const requirement = requiredModels[model];
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
    state.installationsByModel.set(model, kept);
  }

  return toUninstall;
}

function nodeAlreadyHostsModel(
  nodeId: string,
  specifier: string,
  state: ClusterState,
  pending: NewInstallation[],
): boolean {
  const existing = state.installationsByServer.get(nodeId) ?? [];
  if (existing.some(inst => inst.specifier === specifier)) return true;
  return pending.some(p => p.nodeId === nodeId && p.specifier === specifier);
}

/** What a model demands of a node, beyond the driver and the room to hold it. */
export type PlacementConstraints = {
  minVersion?: string;
  blockedVersions?: BlockedVersion[];
  requiredPlatforms?: string[];
  requiredFeatures?: string[];
};

/** Picks a node according to the configured strategy; skips nodes that already host the model. */
export function findServerForModel(
  specifier: string,
  driver: string,
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

    if (nodeAlreadyHostsModel(server.id, specifier, state, pending)) continue;

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

/** Ollama installations share OLLAMA_PORT; every other driver gets a fresh port. */
function allocatePort(driver: string, nodeId: string, state: ClusterState, pending: NewInstallation[]): number {
  if (driver === "ollama") return OLLAMA_PORT;

  const nodeInstalls = state.installationsByServer.get(nodeId) || [];
  const usedPorts = new Set([
    ...nodeInstalls.filter(i => i.driver !== "ollama").map(i => i.port),
    ...pending.filter(p => p.nodeId === nodeId && p.driver !== "ollama").map(p => p.port!),
  ]);
  let port = VLLM_PORT_BASE;
  while (usedPorts.has(port)) port++;
  return port;
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

  for (const [specifier, requirement] of Object.entries(requiredModels)) {
    const current = (state.installationsByModel.get(specifier) || []).length;
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

      const nodeId = findServerForModel(specifier, driver, totalCapacity, state, toInstall, strategy,
        { minVersion, blockedVersions, requiredPlatforms, requiredFeatures });
      if (!nodeId) {
        log.warn({ specifier: requirement.specifier }, "No server with enough capacity for additional replica");
        break;
      }

      const port = allocatePort(driver, nodeId, state, toInstall);
      toInstall.push({
        nodeId,
        specifier: requirement.specifier,
        estCapacity: totalCapacity,
        kvCacheCapacity: effectiveKvCache,
        driver,
        port,
        settings: requirement.settings,
      });

      const cap = state.serverCapacity.get(nodeId)!;
      cap.used += totalCapacity;
      usedVram += totalCapacity;
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
    install.specifier, install.driver, install.estCapacity, state, [], "first-fit",
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
    getDB().select().from(aiNodeT).where(sql`
      ${aiNodeT.available}
    AND
      ${aiNodeT.deletedAt} IS NULL
    `),
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
  const toInstall = await planNewInstallations(requiredModels, state, maxVramGb(), serverEnv.DEPLOYMENT_STRATEGY);
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
