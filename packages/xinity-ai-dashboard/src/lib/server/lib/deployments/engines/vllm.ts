import { runsTensorParallel, tensorParallelLayouts, type OptimizationGoal } from "common-env";
import type { CardCapacity } from "../cluster-state";
import { requirementKey } from "../placement";
import { orderByStrategy, type DeploymentStrategy } from "../strategy";
import type { EngineScheduler, PlacementModel } from "./engine";

const VLLM_PORT_BASE = 11435;

// A node whose cards cannot be pinned runs vLLM on its first card.
function placeableCards(cards: CardCapacity[]): CardCapacity[] {
  const pinnable = cards.filter((card) => card.id !== null);
  return pinnable.length > 0 ? pinnable : cards.slice(0, 1);
}

export type VllmLayout = { cards: CardCapacity[]; perCardGb: number };

// vLLM gives every rank the same share and one utilization fraction, so a split spans identical cards only.
function identicalCardGroups(cards: CardCapacity[]): CardCapacity[][] {
  const groups = new Map<string, CardCapacity[]>();
  for (const card of cards) {
    const key = `${card.vendor}:${card.name}:${card.total}`;
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  return [...groups.values()];
}

function vllmLayouts(
  cards: CardCapacity[],
  model: PlacementModel,
  kvCacheGb: number,
  strategy: DeploymentStrategy,
): VllmLayout[] {
  const sizing = { weightGb: model.weight, attentionHeads: model.attentionHeads, kvHeads: model.kvHeads, mlaAttention: model.mlaAttention };

  return identicalCardGroups(placeableCards(cards)).flatMap((group) => {
    const ordered = orderByStrategy(strategy, group, (card) => card);
    const maxTensorParallel = runsTensorParallel(group[0]!.vendor) ? group.length : 1;
    return tensorParallelLayouts(sizing, { cards: maxTensorParallel, kvCacheGb }).flatMap((layout) => {
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
  cards: CardCapacity[],
  model: PlacementModel,
  kvCacheGb: number,
  goal: OptimizationGoal,
  strategy: DeploymentStrategy,
): VllmLayout | undefined {
  return vllmLayouts(cards, model, kvCacheGb, strategy).sort(LAYOUT_PREFERENCE[goal])[0];
}

// Each vLLM installation is its own process on its own cards, so only replicas of one deployment
// side are spread across nodes, and the daemon runs an unpinned one on the node's first card.
export const vllmScheduler: EngineScheduler = {
  excludes: (placed, candidate) => requirementKey(placed) === requirementKey(candidate),
  placeOnNode: (cards, request) => {
    const layout = layoutForVllm(cards, request.model, request.kvCacheGb, request.goal, request.strategy);
    if (!layout) {
      return undefined;
    }
    return {
      gpuIds: layout.cards.flatMap((card) => (card.id ? [card.id] : [])),
      estCapacity: layout.perCardGb * layout.cards.length,
    };
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
