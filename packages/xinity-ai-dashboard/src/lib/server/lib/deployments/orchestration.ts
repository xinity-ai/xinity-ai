import { inArray, modelDeploymentT, sql, modelInstallationT, modelInstallationStateT, aiNodeT, nodeIsLive, type ModelInstallation, type AiNode } from "common-db";
import { DOES_NOT_FIT_ON_NODE, GROUP_MEMBER_FEATURE, deriveInterconnectOverview, freeMemberAddress, resolveOptimizeFor, settingsEqual, sharedRdmaSubnets, type Coupling, type FootprintPart, type InstallationGroup, type OptimizationGoal } from "common-env";
import { getDB } from "$lib/server/db";
import { resolveSchedulable, type SchedulableModel } from "$lib/server/lib/models/model-catalog";
import { checkNodeCompatibility, type BlockedVersion, type ModelNodeRequirements, type NodeCapability, type Provider } from "common-env/model-catalog";
import { rootLogger } from "$lib/server/logging";
import { building } from "$app/environment";
import { maxVramGb } from "$lib/server/license";
import { config } from "$lib/server/config";
import { buildClusterState, chargeCapacity, chargeOf, freeGbOn, poolCharge, rankServers, releaseInstallationFromState, replicasOf, resourcesOf, type ClusterState, type NewInstallation } from "./cluster-state";
import { ENGINE_SCHEDULERS } from "./engines";
import type { MemberSlot, NodeSlot, PlacementRequest } from "./engines/engine";
import type { Placement } from "./placement";
import { requirementsForDeployments, type ModelRequirementTable } from "./requirements";
import type { Capacity, DeploymentStrategy } from "./strategy";

const log = rootLogger.child({ name: "orchestration.mod" })

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
    const replicas = replicasOf(installs);
    if (replicas.length <= required) continue;

    const excess = replicas.length - required;
    for (const rem of replicas.slice(0, excess).flat()) {
      toUninstall.push(rem.id);
      releaseInstallationFromState(state, rem);
    }
    state.installationsByRequirement.set(key, replicas.slice(excess).flat());
  }

  return toUninstall;
}

/** Returns all installations that can and should be released */
function releaseReplicas(state: ClusterState, release: (replica: ModelInstallation[], requirementKey: string) => boolean): string[] {
  const toUninstall: string[] = [];
  for (const [key, installs] of state.installationsByRequirement) {
    const kept: ModelInstallation[] = [];
    for (const replica of replicasOf(installs)) {
      if (!release(replica, key)) {
        kept.push(...replica);
        continue;
      }
      for (const install of replica) {
        toUninstall.push(install.id);
        releaseInstallationFromState(state, install);
      }
    }
    state.installationsByRequirement.set(key, kept);
  }
  return toUninstall;
}

export function collectDriftedInstallations(requiredModels: ModelRequirementTable, state: ClusterState): string[] {
  return releaseReplicas(state, (replica, key) => {
    const requirement = requiredModels[key];
    return requirement !== undefined && !settingsEqual(replica[0]!.settings, requirement.settings);
  });
}

export function collectReplicasThatDoNotFit(doesNotFitIds: ReadonlySet<string>, state: ClusterState): string[] {
  return releaseReplicas(state, (replica) => replica.some((install) => doesNotFitIds.has(install.id)));
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

function nodeCouldServe(server: AiNode, driver: Provider, constraints: PlacementConstraints): boolean {
  return checkNodeCompatibility(
    { free: Infinity, driverVersions: server.driverVersions, driverFeatures: server.driverFeatures ?? {}, gpus: server.gpus },
    { driver, capacityGb: 0, ...constraints, requiredPlatforms: constraints.requiredPlatforms ?? [] },
  ) === null;
}

export type GroupPlacement = { coupling: Coupling; members: MemberSlot[] };

export type ReplicaPlacement = { members: MemberSlot[]; coupling?: Coupling };

const ranksOf = (members: MemberSlot[]) => members.reduce((total, member) => total + Math.max(member.gpuIds.length, 1), 0);

const GROUP_PREFERENCE: Record<OptimizationGoal, (a: GroupPlacement, b: GroupPlacement) => number> = {
  space: (a, b) => ranksOf(a.members) - ranksOf(b.members) || a.members.length - b.members.length,
  speed: (a, b) => ranksOf(b.members) - ranksOf(a.members) || a.members.length - b.members.length,
};

export function findGroupForModel(
  placement: Placement,
  driver: Provider,
  need: Omit<PlacementRequest, "strategy">,
  state: ClusterState,
  pending: NewInstallation[],
  strategy: DeploymentStrategy,
  constraints: PlacementConstraints = {},
): GroupPlacement | null {
  const groupsAcrossNodes = ENGINE_SCHEDULERS[driver].groupsAcrossNodes;
  if (!groupsAcrossNodes) {
    return null;
  }
  const memberConstraints = { ...constraints, requiredFeatures: [...(constraints.requiredFeatures ?? []), GROUP_MEMBER_FEATURE] };
  const ranked = rankServers(strategy, state);
  const groups = deriveInterconnectOverview(state.availableServers).couplings
    .filter((coupling) => coupling.viable)
    .flatMap((coupling) => {
      const candidates = ranked
        .filter((server) => coupling.nodeIds.includes(server.id))
        .filter((server) => nodeCouldServe(server, driver, memberConstraints) && !nodeExcludesPlacement(server.id, driver, placement, state, pending))
        .map((server) => ({ nodeId: server.id, node: resourcesOf(state, server.id) }));
      return groupsAcrossNodes(candidates, { ...need, strategy }).map((members) => ({ coupling, members }));
    });
  return groups.sort(GROUP_PREFERENCE[need.goal])[0] ?? null;
}

export function findPlacement(
  placement: Placement,
  driver: Provider,
  need: Omit<PlacementRequest, "strategy">,
  state: ClusterState,
  pending: NewInstallation[],
  strategy: DeploymentStrategy,
  constraints: PlacementConstraints = {},
): ReplicaPlacement | null {
  const nodeId = findServerForModel(placement, driver, need, state, pending, strategy, constraints);
  const slot = nodeId ? ENGINE_SCHEDULERS[driver].placeOnNode(resourcesOf(state, nodeId), { ...need, strategy }) : undefined;
  const single = nodeId && slot ? { members: [{ nodeId, ...slot }] } : null;
  if (single && need.goal === "space") {
    return single;
  }
  const group = findGroupForModel(placement, driver, need, state, pending, strategy, constraints);
  if (!group || (single && ranksOf(single.members) >= ranksOf(group.members))) {
    return single;
  }
  return group;
}

const RENDEZVOUS_PORT_BASE = 29500;

function installationsOn(nodeId: string, state: ClusterState, pending: NewInstallation[]): Pick<NewInstallation, "port" | "group">[] {
  return [...(state.installationsByServer.get(nodeId) ?? []), ...pending.filter((p) => p.nodeId === nodeId)];
}

function rendezvousPort(nodeId: string, state: ClusterState, pending: NewInstallation[]): number {
  const used = new Set(installationsOn(nodeId, state, pending).flatMap((i) => (i.group?.rank === 0 ? [i.group.rendezvousPort] : [])));
  let port = RENDEZVOUS_PORT_BASE;
  while (used.has(port)) {
    port++;
  }
  return port;
}

function takenCouplingAddresses(state: ClusterState, pending: NewInstallation[]): Set<string> {
  const portAddresses = state.availableServers.flatMap((server) =>
    server.interconnect.flatMap((port) => port.paths.flatMap((path) => path.ipv4.map((cidr) => cidr.split("/")[0]!))));
  const memberAddresses = [...[...state.installationsByServer.values()].flat(), ...pending]
    .flatMap((installation) => installation.group?.addresses.map(({ address }) => address) ?? []);
  return new Set([...portAddresses, ...memberAddresses]);
}

function memberGroups(coupling: Coupling, members: MemberSlot[], state: ClusterState, pending: NewInstallation[]): InstallationGroup[] | undefined {
  const ports = coupling.members.flatMap((ref) => {
    const port = state.availableServers.find((server) => server.id === ref.nodeId)?.interconnect
      .find((candidate) => candidate.networkCard === ref.networkCard && candidate.port === ref.port);
    return port ? [{ nodeId: ref.nodeId, port }] : [];
  });
  const subnets = sharedRdmaSubnets(ports, members.map((member) => member.nodeId));
  const taken = takenCouplingAddresses(state, pending);
  const addresses = members.map(() => subnets.flatMap(({ subnet }) => {
    const address = freeMemberAddress(subnet, taken);
    if (!address) {
      return [];
    }
    taken.add(address);
    return [{ subnet, address }];
  }));
  if (subnets.length === 0 || addresses.some((assigned) => assigned.length < subnets.length)) {
    return undefined;
  }
  const id = crypto.randomUUID();
  const port = rendezvousPort(members[0]!.nodeId, state, pending);
  return members.map((_, rank) => ({ id, rank, size: members.length, rendezvousPort: port, addresses: addresses[rank]!, generation: 1 }));
}

function allocatePort(driver: Provider, nodeId: string, state: ClusterState, pending: NewInstallation[]): number {
  return ENGINE_SCHEDULERS[driver].port(new Set(installationsOn(nodeId, state, pending).map((i) => i.port)));
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

export type Shortfall = { specifier: string; missing: number; reason: ShortfallReason; constraints?: PlacementConstraints & { driver: Provider }; need?: CapacityNeed };

export type InstallationPlan = { toInstall: NewInstallation[]; shortfalls: Shortfall[]; partsOf: FootprintPart[][] };

function anyNodeCouldServe(state: ClusterState, driver: Provider, constraints: PlacementConstraints): boolean {
  return state.availableServers.some((server) => nodeCouldServe(server, driver, constraints));
}

export type MachineNeed = { machine: string; neededGb: number; freeGb: number; sharedMemory: boolean; parts: FootprintPart[] };

export type CapacityNeed = { machines: number; perMachine: MachineNeed[] };

const withNothingInstalled = (state: ClusterState): ClusterState => {
  const unused = <T extends Capacity>(capacity: T): T => ({ ...capacity, used: 0 });
  return {
    ...state,
    installationsByRequirement: new Map(),
    installationsByServer: new Map(),
    serverCapacity: new Map([...state.serverCapacity].map(([nodeId, capacity]) => [nodeId, unused(capacity)])),
    cardCapacity: new Map([...state.cardCapacity].map(([nodeId, cards]) => [nodeId, cards.map(unused)])),
    hostCapacity: new Map([...state.hostCapacity].map(([nodeId, capacity]) => [nodeId, unused(capacity)])),
  };
};

export function capacityNeed(
  placement: Placement,
  state: ClusterState,
  driver: Provider,
  need: Omit<PlacementRequest, "strategy">,
  constraints: PlacementConstraints,
  strategy: DeploymentStrategy,
): CapacityNeed | undefined {
  const empty = withNothingInstalled(state);
  const machineNeed = (nodeId: string, slot: NodeSlot): MachineNeed => {
    const server = state.availableServers.find((candidate) => candidate.id === nodeId)!;
    const node = resourcesOf(state, nodeId);
    return {
      machine: server.machineName ?? server.host,
      neededGb: poolCharge(node, slot),
      freeGb: freeGbOn(state, nodeId),
      sharedMemory: node.unified,
      parts: slot.parts ?? [],
    };
  };
  // Each machine is charged in its own way, so it is measured against what it needs placed with nothing else on it.
  const alone = state.availableServers
    .filter((server) => nodeCouldServe(server, driver, constraints))
    .flatMap((server) => {
      const slot = ENGINE_SCHEDULERS[driver].placeOnNode(resourcesOf(empty, server.id), { ...need, strategy });
      return slot ? [machineNeed(server.id, slot)] : [];
    });
  const members = alone.length > 0
    ? []
    : (findGroupForModel(placement, driver, need, empty, [], strategy, constraints)?.members ?? []).map((member) => machineNeed(member.nodeId, member));
  const perMachine = (alone.length > 0 ? alone : members).toSorted((a, b) => (a.neededGb - a.freeGb) - (b.neededGb - b.freeGb));
  return perMachine.length > 0 ? { machines: Math.max(members.length, 1), perMachine } : undefined;
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
  const partsOf: FootprintPart[][] = [];
  const shortfalls: Shortfall[] = [];
  let usedVram = totalVramUsed(state);

  for (const [key, requirement] of Object.entries(requiredModels)) {
    const { specifier } = requirement;
    const current = replicasOf(state.installationsByRequirement.get(key) || []).length;
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
      const replica = findPlacement({ deploymentId: requirement.deploymentId, specifier }, driver, need, state, toInstall, strategy, constraints);
      const groups = replica?.coupling ? memberGroups(replica.coupling, replica.members, state, toInstall) : undefined;
      if (!replica || (replica.coupling && !groups)) {
        log.warn({ specifier: requirement.specifier }, "No server with enough capacity for additional replica");
        const reason = anyNodeCouldServe(state, driver, constraints) ? "no_capacity" : "no_compatible_node";
        shortfalls.push({
          specifier, missing: needed - i, reason, constraints: { ...constraints, driver },
          need: reason === "no_capacity" ? capacityNeed({ deploymentId: requirement.deploymentId, specifier }, state, driver, need, constraints, strategy) : undefined,
        });
        break;
      }

      const gpuGb = replica.members.reduce((total, member) => total + member.estCapacity, 0);
      if (usedVram + gpuGb > licenseVramLimit) {
        log.warn(
          { specifier: requirement.specifier, usedVram, licenseVramLimit, additional: gpuGb },
          "License VRAM limit reached; skipping additional replica",
        );
        shortfalls.push({ specifier, missing: needed - i, reason: "license_limit" });
        break;
      }

      replica.members.forEach((member, rank) => {
        const installation: NewInstallation = {
          nodeId: member.nodeId,
          deploymentId: requirement.deploymentId,
          specifier: requirement.specifier,
          estCapacity: member.estCapacity,
          kvCacheCapacity: effectiveKvCache,
          hostCapacity: member.hostCapacity,
          maxNumSeqs: member.maxNumSeqs,
          driver,
          port: allocatePort(driver, member.nodeId, state, toInstall),
          settings: requirement.settings,
          gpuIds: member.gpuIds,
          group: groups?.[rank] ?? null,
        };
        toInstall.push(installation);
        partsOf.push(member.parts ?? []);
        chargeCapacity(state, installation, member);
      });
      usedVram += gpuGb;
    }
  }

  return { toInstall, shortfalls, partsOf };
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
  // A group placed anew frees what its members on live nodes hold, so they are left out while looking.
  const liveMembers = install.group
    ? [...state.installationsByServer.values()].flat().filter((other) => other.group?.id === install.group!.id)
    : [];
  liveMembers.forEach((member) => releaseInstallationFromState(state, member));
  const target = findPlacement(install, install.driver, need, state, [], "first-fit", modelInfo);
  for (const member of liveMembers) {
    chargeCapacity(state, member, chargeOf(member));
    state.installationsByServer.get(member.nodeId)?.push(member);
  }
  return target !== null;
}

export async function collectReassignableOrphans(
  orphanedCandidates: ModelInstallation[],
  state: ClusterState,
  lookupModel: ModelLookup,
): Promise<ModelInstallation[]> {
  const replicas = replicasOf(orphanedCandidates);
  const reassignable = await Promise.all(replicas.map((replica) => hasReassignmentTarget(replica[0]!, state, lookupModel)));
  return replicas.filter((_, i) => reassignable[i]).flat();
}

export function collectGroupsOf(installations: ModelInstallation[], state: ClusterState): string[] {
  const groupIds = new Set(installations.flatMap((install) => (install.group ? [install.group.id] : [])));
  return releaseReplicas(state, (replica) => groupIds.has(replica[0]!.group?.id ?? ""));
}

export function collectIncompleteGroups(existing: ModelInstallation[], state: ClusterState): string[] {
  const incomplete = replicasOf(existing).filter((replica) => replica[0]!.group && replica.length < replica[0]!.group.size).flat();
  const offline = incomplete.filter((install) => !state.installationsByServer.has(install.nodeId)).map((install) => install.id);
  return [...offline, ...collectGroupsOf(incomplete, state)];
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

export type PlannedMachine = { machineName: string; cards: number; gpuGb: number; hostGb: number; sharedMemory: boolean; parts: FootprintPart[] };

export type PlannedReplica = { specifier: string; machines: PlannedMachine[] };

export type PlacementPreview = { replicas: PlannedReplica[]; shortfalls: Shortfall[] };

const lookupSchedulable: ModelLookup = async (specifier, driver) => {
  const resolution = await resolveSchedulable(specifier, driver);
  return resolution.status === "found" ? resolution.model : null;
};

export async function currentClusterState(replacedDeploymentId?: string): Promise<{ state: ClusterState; servers: AiNode[] }> {
  const [existing, servers]: [ModelInstallation[], AiNode[]] = await Promise.all([
    getDB().select().from(modelInstallationT).where(sql`${modelInstallationT.deletedAt} IS NULL`),
    getDB().select().from(aiNodeT).where(nodeIsLive),
  ]);
  const liveIds = new Set(servers.map((server) => server.id));
  const others = existing.filter((install) => liveIds.has(install.nodeId) && install.deploymentId !== replacedDeploymentId);
  return { state: buildClusterState(await chargeUnchargedInstallations(others, servers, lookupSchedulable), servers), servers };
}

export async function previewPlacement(requirements: ModelRequirementTable, replacedDeploymentId?: string): Promise<PlacementPreview> {
  const { state, servers } = await currentClusterState(replacedDeploymentId);
  const { toInstall, shortfalls, partsOf } = await planNewInstallations(requirements, state, maxVramGb(), config.compute.deploymentStrategy());
  const machineName = (nodeId: string) => {
    const server = servers.find((candidate) => candidate.id === nodeId);
    return server?.machineName ?? server?.host ?? nodeId;
  };
  return {
    replicas: replicasOf(toInstall.map((install, index) => ({ ...install, id: String(index), group: install.group ?? null }))).map((members) => ({
      specifier: members[0]!.specifier,
      machines: members.map((install) => ({
        machineName: machineName(install.nodeId),
        cards: Math.max(install.gpuIds?.length ?? 0, 1),
        gpuGb: install.estCapacity,
        hostGb: install.hostCapacity ?? 0,
        sharedMemory: resourcesOf(state, install.nodeId).unified,
        parts: partsOf[Number(install.id)] ?? [],
      })),
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

async function installationsThatDoNotFit(): Promise<Set<string>> {
  const rows = await getDB().select({ id: modelInstallationStateT.id }).from(modelInstallationStateT).where(sql`
    ${modelInstallationStateT.lifecycleState} = 'failed'
  AND
    ${modelInstallationStateT.errorMessage} LIKE ${`${DOES_NOT_FIT_ON_NODE}%`}
  `);
  return new Set(rows.map((row) => row.id));
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
    ...collectGroupsOf(orphaned, state),
    ...collectIncompleteGroups(existing, state),
    ...collectExcessInstallations(requiredModels, state),
    ...collectDriftedInstallations(requiredModels, state),
    ...collectReplicasThatDoNotFit(await installationsThatDoNotFit(), state),
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
