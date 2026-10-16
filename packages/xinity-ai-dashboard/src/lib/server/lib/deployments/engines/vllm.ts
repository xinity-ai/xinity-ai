import {
  deploymentFootprint,
  engineProfile,
  imagesInFlight,
  layoutOptions,
  maxNumSeqs,
  runsTensorParallel,
  tensorParallelLayouts,
  type FootprintEntry,
  type OptimizationGoal,
} from "common-env";
import { poolCharge, type CardCapacity, type NodeResources } from "../cluster-state";
import { requirementKey } from "../placement";
import { orderByStrategy, type DeploymentStrategy } from "../strategy";
import type { Charge, EngineScheduler, PlacementModel, PlacementRequest } from "./engine";

const VLLM_PORT_BASE = 11435;

// A node whose cards cannot be pinned runs vLLM on its first card.
function placeableCards(cards: CardCapacity[]): CardCapacity[] {
  const pinnable = cards.filter((card) => card.id !== null);
  return pinnable.length > 0 ? pinnable : cards.slice(0, 1);
}

type PerCardCharge = { perCardGb: number; hostGb: number; maxNumSeqs: number | null };

export type VllmLayout = PerCardCharge & { cards: CardCapacity[] };

// vLLM gives every rank the same share and one utilization fraction, so a split spans identical cards only.
function identicalCardGroups(cards: CardCapacity[]): CardCapacity[][] {
  const groups = new Map<string, CardCapacity[]>();
  for (const card of cards) {
    const key = `${card.vendor}:${card.name}:${card.total}`;
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  return [...groups.values()];
}


function footprintCharge(entry: FootprintEntry, node: NodeResources, kvCacheGb: number, cards: number, vendor: string): PerCardCharge | undefined {
  const layout = { cardsPerNode: cards, nodes: 1 };
  const allowed = layoutOptions(entry, { maxCardsPerNode: cards, maxNodes: 1, vendor, engineVersion: node.engineVersion })
    .some((option) => option.allowed && option.layout.cardsPerNode === cards);
  if (!allowed) {
    return undefined;
  }
  const footprint = deploymentFootprint(entry, {
    layout,
    kvCacheGb,
    imagesInFlight: imagesInFlight(entry, node.gpus, kvCacheGb),
    profile: engineProfile("vllm", node.engineVersion),
  });
  return footprint && { perCardGb: footprint.ranks[0]!.gpuGb, hostGb: footprint.hostGb, maxNumSeqs: maxNumSeqs(entry, node.gpus, kvCacheGb) };
}

function weightsAndKvCharge(model: PlacementModel, kvCacheGb: number, cards: number): PerCardCharge | undefined {
  const sizing = { weightGb: model.weight, attentionHeads: model.attentionHeads, kvHeads: model.kvHeads, mlaAttention: model.mlaAttention };
  const layout = tensorParallelLayouts(sizing, { cards, kvCacheGb }).find((candidate) => candidate.tensorParallelSize === cards);
  return layout && { perCardGb: layout.perCardWeightGb + layout.perCardKvCacheGb, hostGb: 0, maxNumSeqs: null };
}

function perCardCharge(model: PlacementModel, node: NodeResources, kvCacheGb: number, cards: number, vendor: string): PerCardCharge | undefined {
  return model.footprint
    ? footprintCharge(model.footprint, node, kvCacheGb, cards, vendor)
    : weightsAndKvCharge(model, kvCacheGb, cards);
}

const asCharge = ({ perCardGb, hostGb, maxNumSeqs }: PerCardCharge, cards: number): Charge => ({ estCapacity: perCardGb * cards, hostCapacity: hostGb, maxNumSeqs });

function vllmLayouts(node: NodeResources, model: PlacementModel, kvCacheGb: number, strategy: DeploymentStrategy): VllmLayout[] {
  const hostFree = node.host && !node.unified ? node.host.total - node.host.used : Infinity;
  return identicalCardGroups(placeableCards(node.cards)).flatMap((group) => {
    const ordered = orderByStrategy(strategy, group, (card) => card);
    const vendor = group[0]!.vendor;
    const maxCards = runsTensorParallel(vendor) ? group.length : 1;
    return Array.from({ length: maxCards }, (_, index) => index + 1).flatMap((cards) => {
      const charge = perCardCharge(model, node, kvCacheGb, cards, vendor);
      if (!charge || charge.hostGb > hostFree) {
        return [];
      }
      const onEachCard = poolCharge(node, asCharge(charge, cards)) / cards;
      const fitting = ordered.filter((card) => card.total - card.used >= onEachCard);
      return fitting.length >= cards ? [{ cards: fitting.slice(0, cards), ...charge }] : [];
    });
  });
}

// Space packs a model onto the fewest cards, speed splits it across the most.
const LAYOUT_PREFERENCE: Record<OptimizationGoal, (a: VllmLayout, b: VllmLayout) => number> = {
  space: (a, b) => a.cards.length - b.cards.length,
  speed: (a, b) => b.cards.length - a.cards.length,
};

export function layoutForVllm(
  node: NodeResources,
  model: PlacementModel,
  kvCacheGb: number,
  goal: OptimizationGoal,
  strategy: DeploymentStrategy,
): VllmLayout | undefined {
  return vllmLayouts(node, model, kvCacheGb, strategy).sort(LAYOUT_PREFERENCE[goal])[0];
}

// Each vLLM installation is its own process on its own cards, so only replicas of one deployment
// side are spread across nodes, and the daemon runs an unpinned one on the node's first card.
export const vllmScheduler: EngineScheduler = {
  excludes: (placed, candidate) => requirementKey(placed) === requirementKey(candidate),
  placeOnNode: (node, request: PlacementRequest) => {
    const layout = layoutForVllm(node, request.model, request.kvCacheGb, request.goal, request.strategy);
    if (!layout) {
      return undefined;
    }
    return {
      gpuIds: layout.cards.flatMap((card) => (card.id ? [card.id] : [])),
      ...asCharge(layout, layout.cards.length),
    };
  },
  charge: (node, request, cards) => {
    const vendor = placeableCards(node.cards)[0]?.vendor ?? "";
    const charge = perCardCharge(request.model, node, request.kvCacheGb, cards, vendor);
    return charge && asCharge(charge, cards);
  },
  occupiedCards: (cards, gpuIds) => {
    const pinned = cards.filter((card) => card.id !== null && gpuIds.includes(card.id));
    return pinned.length > 0 ? pinned : cards.slice(0, 1);
  },
  port: (usedPorts) => {
    let port = VLLM_PORT_BASE;
    while (usedPorts.has(port)) {
      port++;
    }
    return port;
  },
};
