import { inArray, modelDeploymentT, sql, calcCanaryProgress, modelInstallationT, aiNodeT, type ModelDeployment, type ModelInstallation, type AiNode, type InferInsertModel } from "common-db";
import { settingsEqual, tensorParallelLayouts, type DeploymentSettings, type OptimizationGoal } from "common-env";
import { getDB } from "$lib/server/db";
import { resolveSchedulable, type SchedulableModel } from "$lib/server/lib/models/model-catalog";
import { checkNodeCompatibility, type BlockedVersion, type ModelNodeRequirements, type NodeCapability, type Provider } from "common-env/model-catalog";
import { rootLogger } from "$lib/server/logging";
import { building } from "$app/environment";
import { maxVramGb } from "$lib/server/license";
import { config } from "$lib/server/config";
import { nodeIsLive } from "./node-liveness";

const log = rootLogger.child({ name: "orchestration.mod" })

const OLLAMA_PORT = 11434;
const VLLM_PORT_BASE = 11435;

type NewInstallation = InferInsertModel<typeof modelInstallationT>;

/** Mutable tracking state built from current DB contents. */
type ClusterState = {
  installationsByRequirement: Map<string, ModelInstallation[]>;
  installationsByServer: Map<string, ModelInstallation[]>;
  serverCapacity: Map<string, Capacity>;
  cardCapacity: Map<string, CardCapacity[]>;
  availableServers: AiNode[];
}

type Capacity = { total: number; used: number };
type CardCapacity = Capacity & { uuid: string | null; name: string };

export type ModelRequirement = { deploymentId: string; specifier: string; replicas: number; kvCacheSize: number | null; preferredDriver: Provider | null; settings: DeploymentSettings };
export type ModelRequirementTable = Record<string, ModelRequirement>;

export type DeploymentStrategy = "first-fit" | "balanced" | "bin-pack" | "proportional";

/** Returns availableServers ordered by the given strategy's preference.
 * Re-evaluated per placement so spread strategies see updated `used` after each replica. */
export function rankServers(strategy: DeploymentStrategy, state: ClusterState): AiNode[] {
  return orderByStrategy(strategy, state.availableServers, (server) => state.serverCapacity.get(server.id));
}

function orderByStrategy<T>(strategy: DeploymentStrategy, items: T[], capacityOf: (item: T) => Capacity | undefined): T[] {
  const free = (item: T) => {
    const cap = capacityOf(item);
    return cap ? cap.total - cap.used : 0;
  };
  const ratio = (item: T) => {
    const cap = capacityOf(item);
    return cap && cap.total > 0 ? cap.used / cap.total : 1;
  };
  const ordered = [...items];
  switch (strategy) {
    case "first-fit":    return ordered;
    case "balanced":     return ordered.sort((a, b) => free(b) - free(a));
    case "bin-pack":     return ordered.sort((a, b) => free(a) - free(b));
    case "proportional": return ordered.sort((a, b) => ratio(a) - ratio(b));
  }
}

export function requirementKey(entry: { deploymentId: string; specifier: string }): string {
  return `${entry.deploymentId}:${entry.specifier}`;
}

// One requirement per deployment and model side, since an installation serves exactly one deployment
export function requirementsForDeployments(deployments: ModelDeployment[]): ModelRequirementTable {
  const requirements = deployments.flatMap((deployment): ModelRequirement[] => {
    const progress = calcCanaryProgress(deployment);
    const earlySpecifier = deployment.earlySpecifier;
    const driver = deployment.preferredDriver;
    const isNotCanary = progress === 100 || !earlySpecifier || earlySpecifier === deployment.specifier;
    if (isNotCanary) {
      return [requirementFor(deployment.id, deployment.specifier, deployment.replicas, deployment.kvCacheSize, driver, deployment.settings)];
    }
    return [
      requirementFor(deployment.id, deployment.specifier, Math.ceil(deployment.replicas * (progress / 100)), deployment.kvCacheSize, driver, deployment.settings),
      requirementFor(deployment.id, earlySpecifier, Math.ceil(deployment.replicas * ((100 - progress) / 100)), deployment.earlyKvCacheSize, driver, deployment.settings),
    ];
  });
  return Object.fromEntries(requirements.map((requirement) => [requirementKey(requirement), requirement]));
}

// Builds the replica requirement table based on enabled deployments.
export async function assembleModelRequirementTable(): Promise<ModelRequirementTable> {
  const enabledDeployments = await getDB().select().from(modelDeploymentT).where(sql`
    ${modelDeploymentT.enabled}
  AND
    ${modelDeploymentT.deletedAt} IS NULL
  `);
  return requirementsForDeployments(enabledDeployments);
}

function requirementFor(
  deploymentId: string,
  specifier: string,
  replicas: number,
  kvCacheSize: number | null,
  preferredDriver: Provider | null,
  settings: DeploymentSettings,
): ModelRequirement {
  return { deploymentId, specifier, replicas, kvCacheSize, preferredDriver, settings };
}

// Without card sizes (unified memory, or none reported) the node is one card of its whole capacity.
function nodeCards(server: AiNode): CardCapacity[] {
  const cards = server.gpus
    .filter((gpu) => gpu.vramMb > 0)
    .map((gpu) => ({ uuid: gpu.uuid ?? null, name: gpu.name, total: gpu.vramMb / 1024, used: 0 }));
  return cards.length > 0 ? cards : [{ uuid: null, name: "", total: server.estCapacity, used: 0 }];
}

// The daemon runs an unpinned vLLM instance on the node's first card, so that card carries it.
function cardsCarrying(state: ClusterState, nodeId: string, gpuUuids: string[]): CardCapacity[] {
  const cards = state.cardCapacity.get(nodeId) ?? [];
  const pinned = cards.filter((card) => card.uuid !== null && gpuUuids.includes(card.uuid));
  return pinned.length > 0 ? pinned : cards.slice(0, 1);
}

function chargeCapacity(
  state: ClusterState,
  nodeId: string,
  driver: string,
  capacity: number,
  gpuUuids: string[],
): void {
  const cap = state.serverCapacity.get(nodeId);
  if (cap) {
    cap.used += capacity;
  }
  if (driver !== "vllm") {
    return;
  }
  const carrying = cardsCarrying(state, nodeId, gpuUuids);
  for (const card of carrying) {
    card.used += capacity / carrying.length;
  }
}

// Only a card with a UUID can be pinned. On a node without any, vLLM lands on the first card unpinned.
export function cardForVllm(state: ClusterState, nodeId: string, capacity: number, strategy: DeploymentStrategy): CardCapacity | undefined {
  const cards = state.cardCapacity.get(nodeId) ?? [];
  const pinnable = cards.filter((card) => card.uuid !== null);
  const candidates = pinnable.length > 0 ? pinnable : cards.slice(0, 1);
  return orderByStrategy(strategy, candidates, (card) => card).find((card) => card.total - card.used >= capacity);
}

export type VllmLayout = { cards: CardCapacity[]; perCardGb: number };

// vLLM gives every rank the same share and one utilization fraction, so a split spans identical cards only.
function identicalCardGroups(cards: CardCapacity[]): CardCapacity[][] {
  const groups = new Map<string, CardCapacity[]>();
  for (const card of cards) {
    const key = `${card.name}:${card.total}`;
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  return [...groups.values()];
}

function vllmLayouts(
  state: ClusterState,
  nodeId: string,
  model: Pick<SchedulableModel, "weight" | "attentionHeads" | "kvHeads" | "mlaAttention">,
  kvCacheGb: number,
  strategy: DeploymentStrategy,
): VllmLayout[] {
  const cards = state.cardCapacity.get(nodeId) ?? [];
  const pinnable = cards.filter((card) => card.uuid !== null);
  const groups = pinnable.length > 0 ? identicalCardGroups(pinnable) : [cards.slice(0, 1)];
  const sizing = { weightGb: model.weight, attentionHeads: model.attentionHeads, kvHeads: model.kvHeads, mlaAttention: model.mlaAttention };

  return groups.flatMap((group) => {
    const ordered = orderByStrategy(strategy, group, (card) => card);
    return tensorParallelLayouts(sizing, { cards: group.length, kvCacheGb }).flatMap((layout) => {
      const perCardGb = layout.perCardWeightGb + layout.perCardKvCacheGb;
      const fitting = ordered.filter((card) => card.total - card.used >= perCardGb);
      return fitting.length >= layout.tensorParallelSize
        ? [{ cards: fitting.slice(0, layout.tensorParallelSize), perCardGb }]
        : [];
    });
  });
}

// Space packs a model onto the fewest cards, speed splits it across the most.
const LAYOUT_PREFERENCE: Record<OptimizationGoal, (a: VllmLayout, b: VllmLayout) => number> = {
  space: (a, b) => a.cards.length - b.cards.length,
  speed: (a, b) => b.cards.length - a.cards.length,
};

export function layoutForVllm(
  state: ClusterState,
  nodeId: string,
  model: Pick<SchedulableModel, "weight" | "attentionHeads" | "kvHeads" | "mlaAttention">,
  kvCacheGb: number,
  goal: OptimizationGoal,
  strategy: DeploymentStrategy,
): VllmLayout | undefined {
  return vllmLayouts(state, nodeId, model, kvCacheGb, strategy).sort(LAYOUT_PREFERENCE[goal])[0];
}

export function buildClusterState(existing: ModelInstallation[], availableServers: AiNode[]): ClusterState {
  const state: ClusterState = {
    installationsByRequirement: new Map(),
    installationsByServer: new Map(),
    serverCapacity: new Map(),
    cardCapacity: new Map(),
    availableServers,
  };

  for (const server of availableServers) {
    state.serverCapacity.set(server.id, { total: server.estCapacity, used: 0 });
    state.cardCapacity.set(server.id, nodeCards(server));
    state.installationsByServer.set(server.id, []);
  }

  for (const install of existing) {
    const key = requirementKey(install);
    const requirementInstalls = state.installationsByRequirement.get(key) || [];
    requirementInstalls.push(install);
    state.installationsByRequirement.set(key, requirementInstalls);

    const serverInstalls = state.installationsByServer.get(install.nodeId);
    if (serverInstalls) {
      serverInstalls.push(install);
      chargeCapacity(state, install.nodeId, install.driver, install.estCapacity, install.gpuUuids);
    }
  }

  return state;
}

function releaseInstallationFromState(state: ClusterState, installation: ModelInstallation): void {
  chargeCapacity(state, installation.nodeId, installation.driver, -installation.estCapacity, installation.gpuUuids);

  const serverInstalls = state.installationsByServer.get(installation.nodeId);
  if (serverInstalls) {
    const idx = serverInstalls.findIndex(i => i.id === installation.id);
    if (idx !== -1) serverInstalls.splice(idx, 1);
  }
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

type Placement = { deploymentId: string; specifier: string };

const EXCLUDED_ON_SAME_NODE: Record<Provider, (placed: Placement, candidate: Placement) => boolean> = {
  ollama: (placed, candidate) => placed.specifier === candidate.specifier,
  vllm: (placed, candidate) => requirementKey(placed) === requirementKey(candidate),
};

function nodeExcludesPlacement(
  nodeId: string,
  driver: Provider,
  candidate: Placement,
  state: ClusterState,
  pending: NewInstallation[],
): boolean {
  const excludes = EXCLUDED_ON_SAME_NODE[driver];
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

    if (driver === "vllm" && !cardForVllm(state, server.id, weight, strategy)) {
      continue;
    }

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
      if (!nodeId) {
        log.warn({ specifier: requirement.specifier }, "No server with enough capacity for additional replica");
        break;
      }

      const port = allocatePort(driver, nodeId, state, toInstall);
      const card = driver === "vllm" ? cardForVllm(state, nodeId, totalCapacity, strategy) : undefined;
      const gpuUuids = card?.uuid ? [card.uuid] : [];
      toInstall.push({
        nodeId,
        deploymentId: requirement.deploymentId,
        specifier: requirement.specifier,
        estCapacity: totalCapacity,
        kvCacheCapacity: effectiveKvCache,
        driver,
        port,
        settings: requirement.settings,
        gpuUuids,
      });

      chargeCapacity(state, nodeId, driver, totalCapacity, gpuUuids);
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
