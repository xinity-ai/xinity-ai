import type { AiNode, ModelInstallation, InferInsertModel, modelInstallationT } from "common-db";
import { chargedAgainstCards, gpuId, sharesHostMemory, type GpuInfo } from "common-env";
import { ENGINE_SCHEDULERS } from "./engines";
import type { Charge } from "./engines/engine";
import { requirementKey } from "./placement";
import { orderByStrategy, type Capacity, type DeploymentStrategy } from "./strategy";

export type NewInstallation = InferInsertModel<typeof modelInstallationT>;

export type CardCapacity = Capacity & { id: string | null; vendor: string; name: string };

export type NodeResources = {
  cards: CardCapacity[];
  unified: boolean;
  host?: Capacity;
  gpus: GpuInfo[];
  engineVersion?: string;
};

export type ClusterState = {
  installationsByRequirement: Map<string, ModelInstallation[]>;
  installationsByServer: Map<string, ModelInstallation[]>;
  serverCapacity: Map<string, Capacity>;
  cardCapacity: Map<string, CardCapacity[]>;
  hostCapacity: Map<string, Capacity>;
  availableServers: AiNode[];
};

// Ranked again for every placement, so spreading strategies see what the previous replica used.
export function rankServers(strategy: DeploymentStrategy, state: ClusterState): AiNode[] {
  return orderByStrategy(strategy, state.availableServers, (server) => state.serverCapacity.get(server.id));
}

// Without card sizes (unified memory, or none reported) the node is one card of its whole capacity.
function nodeCards(server: AiNode): CardCapacity[] {
  const cards = server.gpus
    .filter((gpu) => gpu.vramMb > 0)
    .map((gpu) => ({ id: gpuId(gpu) ?? null, vendor: gpu.vendor, name: gpu.name, total: (gpu.vramMb * 2 ** 20) / 1e9, used: 0 }));
  const [gpu] = server.gpus;
  return cards.length > 0 ? cards : [{ id: null, vendor: gpu?.vendor ?? "", name: gpu?.name ?? "", total: server.estCapacity, used: 0 }];
}

function cardsOf(state: ClusterState, nodeId: string): CardCapacity[] {
  return state.cardCapacity.get(nodeId) ?? [];
}

export function resourcesOf(state: ClusterState, nodeId: string): NodeResources {
  const server = state.availableServers.find((candidate) => candidate.id === nodeId);
  return {
    cards: cardsOf(state, nodeId),
    unified: server ? sharesHostMemory(server.gpus) : false,
    host: state.hostCapacity.get(nodeId),
    gpus: server?.gpus ?? [],
    engineVersion: server?.driverVersions.vllm || undefined,
  };
}

export function freeGbOn(state: ClusterState, nodeId: string): number {
  const capacity = state.serverCapacity.get(nodeId);
  return capacity ? Math.max(0, capacity.total - capacity.used) : 0;
}

export function poolCharge(node: Pick<NodeResources, "unified">, charge: Charge): number {
  return chargedAgainstCards({ gpuGb: charge.estCapacity, hostGb: charge.hostCapacity }, node.unified);
}

export function chargeCapacity(
  state: ClusterState,
  installation: Pick<NewInstallation, "nodeId" | "driver" | "gpuIds">,
  charge: Charge,
  sign: 1 | -1 = 1,
): void {
  const node = resourcesOf(state, installation.nodeId);
  const pooled = sign * poolCharge(node, charge);
  const cap = state.serverCapacity.get(installation.nodeId);
  if (cap) {
    cap.used += pooled;
  }
  const occupied = ENGINE_SCHEDULERS[installation.driver].occupiedCards(node.cards, installation.gpuIds ?? []);
  for (const card of occupied) {
    card.used += pooled / occupied.length;
  }
  if (node.host && !node.unified) {
    node.host.used += sign * charge.hostCapacity;
  }
}

export function replicasOf<T extends Pick<ModelInstallation, "id" | "group">>(installations: T[]): T[][] {
  const byReplica = new Map<string, T[]>();
  for (const installation of installations) {
    const key = installation.group?.id ?? installation.id;
    byReplica.set(key, [...(byReplica.get(key) ?? []), installation]);
  }
  return [...byReplica.values()];
}

export const chargeOf = (installation: Pick<ModelInstallation, "estCapacity" | "hostCapacity" | "maxNumSeqs">): Charge =>
  ({ estCapacity: installation.estCapacity, hostCapacity: installation.hostCapacity ?? 0, maxNumSeqs: installation.maxNumSeqs });

export function buildClusterState(existing: ModelInstallation[], availableServers: AiNode[]): ClusterState {
  const state: ClusterState = {
    installationsByRequirement: new Map(),
    installationsByServer: new Map(),
    serverCapacity: new Map(),
    cardCapacity: new Map(),
    hostCapacity: new Map(),
    availableServers,
  };

  for (const server of availableServers) {
    state.serverCapacity.set(server.id, { total: server.estCapacity, used: 0 });
    state.cardCapacity.set(server.id, nodeCards(server));
    if (server.hostMemoryGb !== null) {
      state.hostCapacity.set(server.id, { total: server.hostMemoryGb, used: 0 });
    }
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
      chargeCapacity(state, install, chargeOf(install));
    }
  }

  return state;
}

export function releaseInstallationFromState(state: ClusterState, installation: ModelInstallation): void {
  chargeCapacity(state, installation, chargeOf(installation), -1);

  const serverInstalls = state.installationsByServer.get(installation.nodeId);
  if (serverInstalls) {
    const idx = serverInstalls.findIndex(i => i.id === installation.id);
    if (idx !== -1) serverInstalls.splice(idx, 1);
  }
}
