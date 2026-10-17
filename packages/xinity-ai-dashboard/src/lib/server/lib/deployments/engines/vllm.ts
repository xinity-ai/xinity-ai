import {
  deploymentFootprint,
  engineProfile,
  imagesInFlight,
  layoutOptions,
  maxNumSeqs,
  runsTensorParallel,
  tensorParallelLayouts,
  type Footprint,
  type FootprintEntry,
  type OptimizationGoal,
} from "common-env";
import { poolCharge, type CardCapacity, type NodeResources } from "../cluster-state";
import { requirementKey } from "../placement";
import { orderByStrategy, type DeploymentStrategy } from "../strategy";
import type { CandidateNode, Charge, EngineScheduler, PlacementModel, PlacementRequest } from "./engine";

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

const loadingGbOn = (node: NodeResources, model: PlacementModel) =>
  engineProfile("vllm", node.engineVersion).hostLoadingPerLargestFile * (model.footprint?.sizing.largestFileGb ?? 0);

function fittingCards(node: NodeResources, cards: CardCapacity[], count: number, perCardGb: number, hostGb: number, loadingGb: number): CardCapacity[] | undefined {
  const hostFree = node.host && !node.unified ? node.host.total - node.host.used : Infinity;
  // Loading needs this room on top of the steady part to start, though only the steady part stays charged.
  if (hostGb + loadingGb > hostFree) {
    return undefined;
  }
  const onEachCard = poolCharge(node, { estCapacity: perCardGb * count, hostCapacity: hostGb + loadingGb, maxNumSeqs: null }) / count;
  const fitting = cards.filter((card) => card.total - card.used >= onEachCard);
  return fitting.length >= count ? fitting.slice(0, count) : undefined;
}

function vllmLayouts(node: NodeResources, model: PlacementModel, kvCacheGb: number, strategy: DeploymentStrategy): VllmLayout[] {
  return identicalCardGroups(placeableCards(node.cards)).flatMap((group) => {
    const ordered = orderByStrategy(strategy, group, (card) => card);
    const vendor = group[0]!.vendor;
    const maxCards = runsTensorParallel(vendor) ? group.length : 1;
    return Array.from({ length: maxCards }, (_, index) => index + 1).flatMap((cards) => {
      const charge = perCardCharge(model, node, kvCacheGb, cards, vendor);
      const fitting = charge && fittingCards(node, ordered, cards, charge.perCardGb, charge.hostGb, loadingGbOn(node, model));
      return charge && fitting ? [{ cards: fitting, ...charge }] : [];
    });
  });
}

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

type MemberLayout = { nodeId: string; cards: CardCapacity[]; hostGb: number };

export type GroupLayout = { members: MemberLayout[]; perCardGb: number; maxNumSeqs: number | null };

type Eligible = { nodeId: string; node: NodeResources; cards: CardCapacity[] };

const cardAndEngineKey = (card: CardCapacity, engineVersion: string | undefined) => `${card.vendor}:${card.name}:${card.total}:${engineVersion ?? ""}`;

function assignRanks(footprint: Footprint, eligible: Eligible[], cardsPerNode: number, model: PlacementModel): MemberLayout[] | undefined {
  const fits = (candidate: Eligible, hostGb: number): MemberLayout | undefined => {
    const cards = fittingCards(candidate.node, candidate.cards, cardsPerNode, footprint.ranks[0]!.gpuGb, hostGb, loadingGbOn(candidate.node, model));
    return cards && { nodeId: candidate.nodeId, cards, hostGb };
  };
  // Only rank 0 has a part of its own, every follower needs the same. So each candidate is tried as
  // rank 0 and the followers are any others that take a follower's part: a node too small for
  // either one role is not lost for the other.
  const [leader, ...followers] = footprint.nodes;
  for (const candidate of eligible) {
    const rankZero = fits(candidate, leader!.hostGb);
    const others = rankZero && eligible
      .filter((other) => other.nodeId !== candidate.nodeId)
      .flatMap((other) => fits(other, followers[0]!.hostGb) ?? [])
      .slice(0, followers.length);
    if (rankZero && others && others.length === followers.length) {
      return [rankZero, ...others];
    }
  }
  return undefined;
}

export function groupLayoutsForVllm(candidates: CandidateNode[], model: PlacementModel, kvCacheGb: number, strategy: DeploymentStrategy): GroupLayout[] {
  const entry = model.footprint;
  if (!entry) {
    return [];
  }
  const byKey = new Map<string, Eligible[]>();
  for (const { nodeId, node } of candidates) {
    for (const group of identicalCardGroups(placeableCards(node.cards))) {
      const key = cardAndEngineKey(group[0]!, node.engineVersion);
      byKey.set(key, [...(byKey.get(key) ?? []), { nodeId, node, cards: orderByStrategy(strategy, group, (card) => card) }]);
    }
  }
  return [...byKey.values()].filter((eligible) => eligible.length > 1).flatMap((eligible) => {
    const { node, cards } = eligible[0]!;
    const maxCardsPerNode = Math.min(...eligible.map((candidate) => candidate.cards.length));
    return layoutOptions(entry, { maxCardsPerNode, maxNodes: eligible.length, vendor: cards[0]!.vendor, engineVersion: node.engineVersion })
      .filter((option) => option.allowed && option.layout.nodes > 1)
      .flatMap(({ layout }) => {
        const footprint = deploymentFootprint(entry, {
          layout,
          kvCacheGb,
          imagesInFlight: imagesInFlight(entry, node.gpus, kvCacheGb),
          profile: engineProfile("vllm", node.engineVersion),
        });
        const members = footprint && assignRanks(footprint, eligible, layout.cardsPerNode, model);
        return members ? [{ members, perCardGb: footprint.ranks[0]!.gpuGb, maxNumSeqs: maxNumSeqs(entry, node.gpus, kvCacheGb) }] : [];
      });
  });
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
  groupsAcrossNodes: (candidates, request) =>
    groupLayoutsForVllm(candidates, request.model, request.kvCacheGb, request.strategy).map((layout) =>
      layout.members.map(({ nodeId, cards, hostGb }) => ({
        nodeId,
        gpuIds: cards.flatMap((card) => (card.id ? [card.id] : [])),
        estCapacity: layout.perCardGb * cards.length,
        hostCapacity: hostGb,
        maxNumSeqs: layout.maxNumSeqs,
      }))),
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
