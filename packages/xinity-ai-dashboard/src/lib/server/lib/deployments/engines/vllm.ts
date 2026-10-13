import { tensorParallelLayouts, type OptimizationGoal } from "common-env";
import type { SchedulableModel } from "$lib/server/lib/models/model-catalog";
import type { CardCapacity } from "../cluster-state";
import { requirementKey } from "../placement";
import { orderByStrategy, type DeploymentStrategy } from "../strategy";
import type { EngineScheduler } from "./engine";

const VLLM_PORT_BASE = 11435;

// Only a card with a UUID can be pinned. On a node without any, vLLM lands on the first card unpinned.
function placeableCards(cards: CardCapacity[]): CardCapacity[] {
  const pinnable = cards.filter((card) => card.uuid !== null);
  return pinnable.length > 0 ? pinnable : cards.slice(0, 1);
}

export function cardForVllm(cards: CardCapacity[], capacity: number, strategy: DeploymentStrategy): CardCapacity | undefined {
  return orderByStrategy(strategy, placeableCards(cards), (card) => card).find((card) => card.total - card.used >= capacity);
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
  cards: CardCapacity[],
  model: Pick<SchedulableModel, "weight" | "attentionHeads" | "kvHeads" | "mlaAttention">,
  kvCacheGb: number,
  strategy: DeploymentStrategy,
): VllmLayout[] {
  const sizing = { weightGb: model.weight, attentionHeads: model.attentionHeads, kvHeads: model.kvHeads, mlaAttention: model.mlaAttention };

  return identicalCardGroups(placeableCards(cards)).flatMap((group) => {
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
  cards: CardCapacity[],
  model: Pick<SchedulableModel, "weight" | "attentionHeads" | "kvHeads" | "mlaAttention">,
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
    const card = cardForVllm(cards, request.capacityGb, request.strategy);
    if (!card) {
      return undefined;
    }
    return { gpuUuids: card.uuid ? [card.uuid] : [], estCapacity: request.capacityGb };
  },
  occupiedCards: (cards, gpuUuids) => {
    const pinned = cards.filter((card) => card.uuid !== null && gpuUuids.includes(card.uuid));
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
