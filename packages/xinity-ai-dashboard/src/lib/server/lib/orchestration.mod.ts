import { inArray, isNull, modelDeploymentT, sql, calcCanaryProgress, modelInstallationT, aiNodeT, type ModelInstallation, type AiNode, type InferInsertModel } from "common-db";
import { getDB } from "../db";
import { infoClient } from "../info-client";
import { resolveDefaultProvider, resolveMinVersionForDriver, resolveRequiredPlatformsForDriver, checkNodeCompatibility, deploymentLookup, deploymentEarlyLookup, installationKey, lookupKey, type ModelNodeRequirements, type NodeCapability, type Provider, type ModelLookup } from "xinity-infoserver";
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

export type ModelRequirement = { lookup: ModelLookup; replicas: number; kvCacheSize: number | null; preferredDriver: Provider | null };
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

function mergeRequirementsByLookupKey(entries: ModelRequirement[]): ModelRequirementTable {
  return entries.reduce((agg, entry) => {
    const key = lookupKey(entry.lookup);
    const existing = agg[key];
    if (!existing) {
      agg[key] = entry;
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
  const models = enabledDeployments.flatMap((deployment) => {
    const progress = calcCanaryProgress(deployment);
    const earlyLookup = deploymentEarlyLookup(deployment);
    const isNotCanary = progress === 100 || !earlyLookup;
    if (isNotCanary) {
      return [{
        lookup: deploymentLookup(deployment),
        replicas: deployment.replicas,
        kvCacheSize: deployment.kvCacheSize,
        preferredDriver: deployment.preferredDriver,
      }]
    }
    const replicas = deployment.replicas;
    return [{
      lookup: deploymentLookup(deployment),
      replicas: Math.ceil(replicas * (progress / 100)),
      kvCacheSize: deployment.kvCacheSize,
      preferredDriver: deployment.preferredDriver,
    }, {
      lookup: earlyLookup!,
      replicas: Math.ceil(replicas * ((100 - progress) / 100)),
      kvCacheSize: deployment.earlyKvCacheSize,
      preferredDriver: deployment.preferredDriver,
    }]
  });
  return mergeRequirementsByLookupKey(models);
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
    const key = installationKey(install);
    const modelInstalls = installationsByModel.get(key) || [];
    modelInstalls.push(install);
    installationsByModel.set(key, modelInstalls);

    const serverInstalls = installationsByServer.get(install.nodeId);
    if (serverInstalls) {
      serverInstalls.push(install);
      const cap = serverCapacity.get(install.nodeId);
      if (cap) cap.used += install.estCapacity;
    }
  }

  return { installationsByModel, installationsByServer, serverCapacity, availableServers };
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
      const cap = state.serverCapacity.get(rem.nodeId);
      if (cap) cap.used -= rem.estCapacity;

      const serverInstalls = state.installationsByServer.get(rem.nodeId);
      if (serverInstalls) {
        const idx = serverInstalls.findIndex(i => i.id === rem.id);
        if (idx !== -1) serverInstalls.splice(idx, 1);
      }
    }
    state.installationsByModel.set(model, installs.slice(excess));
  }

  return toUninstall;
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

    const serverInstalls = state.installationsByServer.get(server.id) || [];
    const alreadyHasModel = serverInstalls.some(inst => installationKey(inst) === specifier)
      || pending.some(p => p.nodeId === server.id && installationKey({ specifier: p.specifier ?? null, model: p.model }) === specifier);
    if (alreadyHasModel) continue;

    const nodeCap: NodeCapability = {
      free: cap.total - cap.used,
      driverVersions: (server.driverVersions ?? {}) as Record<string, string>,
      gpus: (server.gpus ?? []) as { vendor: string; name: string; vramMb: number }[],
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

  for (const [key, requirement] of Object.entries(requiredModels)) {
    const current = (state.installationsByModel.get(key) || []).length;
    if (current >= requirement.replicas) continue;

    const modelStatus = await infoClient?.fetchModelStatus(requirement.lookup);
    if (!modelStatus || modelStatus.status === "unavailable") {
      log.warn({ lookup: requirement.lookup, error: modelStatus?.status === "unavailable" ? modelStatus.error : undefined },
        "Info server unreachable; skipping installation planning for this sync cycle");
      continue;
    }
    if (modelStatus.status === "not_found") {
      log.warn({ lookup: requirement.lookup },
        "Model not found in catalog; installations cannot be scheduled. " +
        "If this model has been intentionally removed, disable or delete the deployment.");
      continue;
    }
    const modelInfo = modelStatus.model;

    const fallback = resolveDefaultProvider(modelInfo);
    const driver: Provider = (requirement.preferredDriver && modelInfo.providers[requirement.preferredDriver])
      ? requirement.preferredDriver
      : (fallback?.driver ?? "ollama");
    const providerModel = modelInfo.providers[driver];
    if (!providerModel) {
      log.warn({ lookup: requirement.lookup, driver }, "Catalog entry has no provider string for the chosen driver; skipping");
      continue;
    }
    const minVersion = resolveMinVersionForDriver(modelInfo, driver);
    const requiredPlatforms = resolveRequiredPlatformsForDriver(modelInfo, driver);
    const needed = requirement.replicas - current;

    const effectiveKvCache = Math.max(requirement.kvCacheSize ?? 0, modelInfo.minKvCache);
    const totalCapacity = modelInfo.weight + effectiveKvCache;

    const installSpecifier = requirement.lookup.kind === "canonical" ? requirement.lookup.specifier : null;

    for (let i = 0; i < needed; i++) {
      if (usedVram + totalCapacity > licenseVramLimit) {
        log.warn(
          { lookup: requirement.lookup, usedVram, licenseVramLimit, additional: totalCapacity },
          "License VRAM limit reached; skipping additional replica",
        );
        break;
      }

      const nodeId = findServerForModel(key, driver, totalCapacity, state, toInstall, strategy, minVersion, requiredPlatforms);
      if (!nodeId) {
        log.warn({ lookup: requirement.lookup }, "No server with enough capacity for additional replica");
        break;
      }

      const port = allocatePort(driver, nodeId, state, toInstall);
      toInstall.push({
        nodeId,
        specifier: installSpecifier,
        model: providerModel,
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
  const existing: ModelInstallation[] = await getDB().select().from(modelInstallationT).where(isNull(modelInstallationT.deletedAt));
  const availableServers: AiNode[] = await getDB().select().from(aiNodeT).where(sql`${aiNodeT.available} AND ${aiNodeT.deletedAt} IS NULL`);

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

/** Starts the background deployment sync loop. */
export async function startDeploymentSyncService() {
  log.info("Starting deployment sync service")
  if (!building) {
    // Warmup period
    await Bun.sleep(1_000);
    await syncDeployedModels();
    const interval = setInterval(syncDeployedModels, 5 * 60_000);
    process.on("beforeExit", () => clearInterval(interval));
  }
}
