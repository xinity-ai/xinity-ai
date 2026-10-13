import type { AiNode, ModelInstallation, InferInsertModel, modelInstallationT } from "common-db";
import { ENGINE_SCHEDULERS } from "./engines";
import { requirementKey } from "./placement";
import { orderByStrategy, type Capacity, type DeploymentStrategy } from "./strategy";

export type NewInstallation = InferInsertModel<typeof modelInstallationT>;

export type CardCapacity = Capacity & { uuid: string | null; name: string };

/** Mutable tracking state built from current DB contents. */
export type ClusterState = {
  installationsByRequirement: Map<string, ModelInstallation[]>;
  installationsByServer: Map<string, ModelInstallation[]>;
  serverCapacity: Map<string, Capacity>;
  cardCapacity: Map<string, CardCapacity[]>;
  availableServers: AiNode[];
};

/** Returns availableServers ordered by the given strategy's preference.
 * Re-evaluated per placement so spread strategies see updated `used` after each replica. */
export function rankServers(strategy: DeploymentStrategy, state: ClusterState): AiNode[] {
  return orderByStrategy(strategy, state.availableServers, (server) => state.serverCapacity.get(server.id));
}

// Without card sizes (unified memory, or none reported) the node is one card of its whole capacity.
function nodeCards(server: AiNode): CardCapacity[] {
  const cards = server.gpus
    .filter((gpu) => gpu.vramMb > 0)
    .map((gpu) => ({ uuid: gpu.uuid ?? null, name: gpu.name, total: gpu.vramMb / 1024, used: 0 }));
  return cards.length > 0 ? cards : [{ uuid: null, name: "", total: server.estCapacity, used: 0 }];
}

export function cardsOf(state: ClusterState, nodeId: string): CardCapacity[] {
  return state.cardCapacity.get(nodeId) ?? [];
}

export function chargeCapacity(
  state: ClusterState,
  installation: Pick<NewInstallation, "nodeId" | "driver" | "gpuUuids">,
  capacity: number,
): void {
  const cap = state.serverCapacity.get(installation.nodeId);
  if (cap) {
    cap.used += capacity;
  }
  const occupied = ENGINE_SCHEDULERS[installation.driver].occupiedCards(cardsOf(state, installation.nodeId), installation.gpuUuids ?? []);
  for (const card of occupied) {
    card.used += capacity / occupied.length;
  }
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
      chargeCapacity(state, install, install.estCapacity);
    }
  }

  return state;
}

export function releaseInstallationFromState(state: ClusterState, installation: ModelInstallation): void {
  chargeCapacity(state, installation, -installation.estCapacity);

  const serverInstalls = state.installationsByServer.get(installation.nodeId);
  if (serverInstalls) {
    const idx = serverInstalls.findIndex(i => i.id === installation.id);
    if (idx !== -1) serverInstalls.splice(idx, 1);
  }
}
