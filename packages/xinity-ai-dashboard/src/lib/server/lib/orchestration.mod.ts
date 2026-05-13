import { inArray, isNull, modelDeploymentT, sql, calcCanaryProgress, modelInstallationT, aiNodeT, type ModelInstallation, type AiNode, type InferInsertModel } from "common-db";
import { getDB } from "../db";
import { infoClient } from "../info-client";
import { resolveDefaultProvider, resolveMinVersionForDriver, resolveRequiredPlatformsForDriver, checkNodeCompatibility, type Model, type ModelNodeRequirements, type NodeCapability, type Provider } from "xinity-infoserver";
import { rootLogger } from "../logging";
import { building } from "$app/environment";
import { maxVramGb } from "$lib/server/license";
import { serverEnv } from "$lib/server/serverenv";

const log = rootLogger.child({ name: "orchestration.mod" })

const OLLAMA_PORT = 11434;
const VLLM_PORT_BASE = 11435;

type NewInstallation = InferInsertModel<typeof modelInstallationT>;

/** Mutable tracking state built from current DB contents. */
interface ClusterState {
  installationsByModel: Map<string, ModelInstallation[]>;
  installationsByServer: Map<string, ModelInstallation[]>;
  serverCapacity: Map<string, { total: number; used: number }>;
  availableServers: AiNode[];
}

export type ModelRequirement = { specifier: string; replicas: number; kvCacheSize: number | null; preferredDriver: Provider | null };
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

function mergeRequirementsBySpecifier(entries: ModelRequirement[]): ModelRequirementTable {
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
      return [requirementFor(deployment.specifier, deployment.replicas, deployment.kvCacheSize, driver)];
    }
    return [
      requirementFor(deployment.specifier, Math.ceil(deployment.replicas * (progress / 100)), deployment.kvCacheSize, driver),
      requirementFor(earlySpecifier!, Math.ceil(deployment.replicas * ((100 - progress) / 100)), deployment.earlyKvCacheSize, driver),
    ];
  });
  return mergeRequirementsBySpecifier(models);
}

function requirementFor(
  specifier: string,
  replicas: number,
  kvCacheSize: number | null,
  preferredDriver: Provider | null,
): ModelRequirement {
  return { specifier, replicas, kvCacheSize, preferredDriver };
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

/** Picks a node according to the configured strategy; skips nodes that already host the model. */
export function findServerForModel(
  specifier: string,
  driver: string,
  weight: number,
  state: ClusterState,
  pending: NewInstallation[],
  strategy: DeploymentStrategy,
  minVersion?: string,
  requiredPlatforms?: string[],
): string | null {
  const req: ModelNodeRequirements = {
    driver, capacityGb: weight,
    minVersion, requiredPlatforms: requiredPlatforms ?? [],
  };

  for (const server of rankServers(strategy, state)) {
    const cap = state.serverCapacity.get(server.id);
    if (!cap) continue;

    if (nodeAlreadyHostsModel(server.id, specifier, state, pending)) continue;

    const nodeCap: NodeCapability = {
      free: cap.total - cap.used,
      driverVersions: server.driverVersions,
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

function pickDriver(modelInfo: Model, preferred: Provider | null): Provider {
  if (preferred && modelInfo.providers[preferred]) return preferred;
  return resolveDefaultProvider(modelInfo)?.driver ?? "ollama";
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

    const modelStatus = await infoClient?.fetchModelStatus(requirement.specifier);
    if (!modelStatus || modelStatus.status === "unavailable") {
      log.warn({ specifier: requirement.specifier, error: modelStatus?.status === "unavailable" ? modelStatus.error : undefined },
        "Info server unreachable; skipping installation planning for this sync cycle");
      continue;
    }
    if (modelStatus.status === "not_found") {
      log.warn({ specifier: requirement.specifier },
        "Model not found in catalog; installations cannot be scheduled. " +
        "If this model has been intentionally removed, disable or delete the deployment.");
      continue;
    }
    const modelInfo = modelStatus.model;

    const driver = pickDriver(modelInfo, requirement.preferredDriver);
    const providerModel = modelInfo.providers[driver];
    if (!providerModel) {
      log.warn({ specifier: requirement.specifier, driver }, "Catalog entry has no provider string for the chosen driver; skipping");
      continue;
    }
    const minVersion = resolveMinVersionForDriver(modelInfo, driver);
    const requiredPlatforms = resolveRequiredPlatformsForDriver(modelInfo, driver);
    const needed = requirement.replicas - current;

    const effectiveKvCache = Math.max(requirement.kvCacheSize ?? 0, modelInfo.minKvCache);
    const totalCapacity = modelInfo.weight + effectiveKvCache;

    for (let i = 0; i < needed; i++) {
      if (usedVram + totalCapacity > licenseVramLimit) {
        log.warn(
          { lookup: requirement.specifier, usedVram, licenseVramLimit, additional: totalCapacity },
          "License VRAM limit reached; skipping additional replica",
        );
        break;
      }

      const nodeId = findServerForModel(specifier, driver, totalCapacity, state, toInstall, strategy, minVersion, requiredPlatforms);
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
      });

      const cap = state.serverCapacity.get(nodeId)!;
      cap.used += totalCapacity;
      usedVram += totalCapacity;
    }
  }

  return toInstall;
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
    getDB().select().from(modelInstallationT).where(isNull(modelInstallationT.deletedAt)),
    getDB().select().from(aiNodeT).where(sql`${aiNodeT.available} AND ${aiNodeT.deletedAt} IS NULL`),
  ]);

  const availableServerIds = new Set(availableServers.map(s => s.id));
  const orphaned = existing.filter(i => !availableServerIds.has(i.nodeId));
  const active = existing.filter(i => availableServerIds.has(i.nodeId));

  log.debug({ requiredModels, installedModels: existing.length, availableServers: availableServers.length, orphaned: orphaned.length }, "Syncing deployed models");

  const state = buildClusterState(active, availableServers);
  const toUninstall = [
    ...orphaned.map(i => i.id),
    ...collectExcessInstallations(requiredModels, state),
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
