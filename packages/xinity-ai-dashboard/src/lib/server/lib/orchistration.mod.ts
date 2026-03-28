import { inArray, isNull, modelDeploymentT, sql, calcCanaryProgress, modelInstallationT, aiNodeT, type ModelInstallation, type AiNode, type InferInsertModel } from "common-db";
import { getDB } from "../db";
import { infoClient } from "../info-client";
import { resolveDriverForProviderModel } from "xinity-infoserver";
import { rootLogger } from "../logging";
import { building } from "$app/environment";

const log = rootLogger.child({ name: "orchistration.mod" })

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

/** Represents required replicas and optional kvCacheSize per model specifier. */
export type ModelRequirement = { replicas: number; kvCacheSize: number | null };
export type ModelRequirementTable = Record<string, ModelRequirement>;

/** Builds the replica requirement table based on enabled deployments. */
export async function assembleModelRequirementTable(): Promise<ModelRequirementTable> {
  const enabledDeployments = await getDB().select().from(modelDeploymentT).where(sql`
    ${modelDeploymentT.enabled} 
  AND 
    ${modelDeploymentT.deletedAt} IS NULL
  `);
  const models = enabledDeployments.flatMap((deployment) => {
    const progress = calcCanaryProgress(deployment);
    const isNotCanary = progress === 100 || !deployment.earlyModelSpecifier;
    if (isNotCanary) {
      return [{
        spec: deployment.modelSpecifier,
        replicas: deployment.replicas,
        kvCacheSize: deployment.kvCacheSize,
      }]
    }
    const replicas = deployment.replicas;
    return [{
      spec: deployment.modelSpecifier,
      replicas: Math.ceil(replicas * (progress / 100)),
      kvCacheSize: deployment.kvCacheSize,
    }, {
      spec: deployment.earlyModelSpecifier!,
      replicas: Math.ceil(replicas * ((100 - progress) / 100)),
      kvCacheSize: deployment.earlyKvCacheSize,
    }]
  });
  // Take the maximum replica count and kvCacheSize when the same specifier appears in multiple deployments
  const modelRequirements = models.reduce((agg, { spec, replicas, kvCacheSize }) => {
    const existing = agg[spec];
    if (existing) {
      if (replicas > existing.replicas) existing.replicas = replicas;
      if (kvCacheSize != null && (existing.kvCacheSize == null || kvCacheSize > existing.kvCacheSize)) {
        existing.kvCacheSize = kvCacheSize;
      }
    } else {
      agg[spec] = { replicas, kvCacheSize };
    }
    return agg;
  }, {} as ModelRequirementTable);
  return modelRequirements;
}

/** Indexes existing installations by model and by server, and initialises capacity tracking. */
export function buildClusterState(existing: ModelInstallation[], availableServers: AiNode[]): ClusterState {
  const installationsByModel = new Map<string, ModelInstallation[]>();
  const installationsByServer = new Map<string, ModelInstallation[]>();
  const serverCapacity = new Map<string, { total: number; used: number }>();

  for (const server of availableServers) {
    serverCapacity.set(server.id, { total: server.estCapacity, used: 0 });
    installationsByServer.set(server.id, []);
  }

  for (const install of existing) {
    const modelInstalls = installationsByModel.get(install.model) || [];
    modelInstalls.push(install);
    installationsByModel.set(install.model, modelInstalls);

    const serverInstalls = installationsByServer.get(install.nodeId);
    if (serverInstalls) {
      serverInstalls.push(install);
      const cap = serverCapacity.get(install.nodeId);
      if (cap) cap.used += install.estCapacity;
    }
  }

  return { installationsByModel, installationsByServer, serverCapacity, availableServers };
}

/** Finds installations that exceed the required replica count and frees their capacity. */
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

/**
 * Picks a server for a new model installation using a first-fit strategy.
 * Skips nodes that already host the model, lack the required driver, or have insufficient capacity.
 */
export function findServerForModel(
  model: string,
  driver: string,
  weight: number,
  state: ClusterState,
  pending: NewInstallation[],
): string | null {
  for (const server of state.availableServers) {
    const cap = state.serverCapacity.get(server.id);
    if (!cap) continue;

    const serverInstalls = state.installationsByServer.get(server.id) || [];
    const alreadyHasModel = serverInstalls.some(inst => inst.model === model)
      || pending.some(p => p.nodeId === server.id && p.model === model);
    if (alreadyHasModel) continue;

    if (!server.drivers.includes(driver)) continue;

    if (cap.total - cap.used >= weight) return server.id;
  }
  return null;
}

/**
 * Allocates a port for an installation on a given node.
 * Ollama shares a single port; vLLM (and other drivers) each get a unique port.
 */
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

/** Plans installations needed to satisfy replica requirements that aren't yet met. */
async function planNewInstallations(requiredModels: ModelRequirementTable, state: ClusterState): Promise<NewInstallation[]> {
  const toInstall: NewInstallation[] = [];

  for (const [model, requirement] of Object.entries(requiredModels)) {
    const current = (state.installationsByModel.get(model) || []).length;
    if (current >= requirement.replicas) continue;

    const modelInfo = await infoClient?.fetchModel(model);
    if (!modelInfo) {
      log.warn({ model }, `Model not found`);
      continue;
    }

    const driver = resolveDriverForProviderModel(modelInfo, model) ?? "ollama";
    const needed = requirement.replicas - current;

    const effectiveKvCache = Math.max(requirement.kvCacheSize ?? 0, modelInfo.minKvCache);
    const totalCapacity = modelInfo.weight + effectiveKvCache;

    for (let i = 0; i < needed; i++) {
      const nodeId = findServerForModel(model, driver, totalCapacity, state, toInstall);
      if (!nodeId) {
        log.warn({ model }, "No server with enough capacity for additional replica");
        break;
      }

      const port = allocatePort(driver, nodeId, state, toInstall);
      toInstall.push({ nodeId, model, estCapacity: totalCapacity, kvCacheCapacity: effectiveKvCache, driver, port });

      const cap = state.serverCapacity.get(nodeId)!;
      cap.used += totalCapacity;
    }
  }

  return toInstall;
}

/** Applies planned installation and uninstallation changes to the database. */
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

/**
 * Syncs the state of model deployments as a "should" set of instructions, to the
 * "is" state of the system described by AINodeT and ModelInstallationT.
 *
 * May very well be called in cases where no changes have to be made at all.
 */
export async function syncDeployedModels() {
  const requiredModels = await assembleModelRequirementTable();
  const existing: ModelInstallation[] = await getDB().select().from(modelInstallationT).where(isNull(modelInstallationT.deletedAt));
  const availableServers: AiNode[] = await getDB().select().from(aiNodeT).where(sql`${aiNodeT.available} AND ${aiNodeT.deletedAt} IS NULL`);

  // Installations on unavailable nodes must be removed and rescheduled
  const availableServerIds = new Set(availableServers.map(s => s.id));
  const orphaned = existing.filter(i => !availableServerIds.has(i.nodeId));
  const active = existing.filter(i => availableServerIds.has(i.nodeId));

  log.debug({ requiredModels, installedModels: existing.length, availableServers: availableServers.length, orphaned: orphaned.length }, "Syncing deployed models");

  const state = buildClusterState(active, availableServers);
  const toUninstall = [
    ...orphaned.map(i => i.id),
    ...collectExcessInstallations(requiredModels, state),
  ];
  const toInstall = await planNewInstallations(requiredModels, state);
  await applyChanges(toUninstall, toInstall);
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
