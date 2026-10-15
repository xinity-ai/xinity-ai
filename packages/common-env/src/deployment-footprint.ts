import type { ModelSizingFields, PlacementLimitFields } from "./model-catalog/definitions/model-definition";
import type { Engine } from "./model-catalog/definitions/model-primitives";
import type { KvPaging } from "./model-catalog/kv-cache-floor";
import { matchesVersionRange, satisfiesMinVersion } from "./model-catalog/semver";
import { estimateConcurrency } from "./model-catalog/throughput-estimate";
import type { GpuInfo } from "./tether-protocol";
import { kvCacheSharePerCard, runsTensorParallel } from "./tensor-parallel";

const GB_PER_GIB = 1.073741824;
const BYTES_PER_GB = 1e9;
const gib = (value: number) => value * GB_PER_GIB;

export type Layout = { cardsPerNode: number; nodes: number };

export const layoutRanks = (layout: Layout) => layout.cardsPerNode * layout.nodes;

export type FootprintEntry = {
  sizing: ModelSizingFields;
  tags: readonly string[];
  engineArgs?: readonly string[];
  placement: { limits: readonly PlacementLimitFields[] };
};

// What the engine itself holds beyond weights and KV, by deployment shape. Values are the measured
// maximum on GB10 with vLLM 0.31, rounded up.
export type EngineProfile = {
  gpuPerRankGb: { whole: number; split: number };
  gpuSpeculativeGb: number;
  hostLeaderGb: number;
  hostFollowerGb: number;
  hostVisionGb: number;
  hostPerImageInFlightGb: number;
  pinnedPerCommunicatorGb: number;
  hostWeightAllocationGb: (gb: number) => number;
  paging: KvPaging;
};

// PyTorch's pinned host allocator rounds every allocation up to a power of two.
function nextPowerOfTwoGb(gb: number): number {
  return gb > 0 ? 2 ** Math.ceil(Math.log2(gb * BYTES_PER_GB)) / BYTES_PER_GB : 0;
}

const VLLM_0_31: EngineProfile = {
  gpuPerRankGb: { whole: gib(2.5), split: gib(3.5) },
  gpuSpeculativeGb: gib(1.5),
  hostLeaderGb: gib(5),
  hostFollowerGb: gib(6),
  hostVisionGb: gib(6.5),
  hostPerImageInFlightGb: 0.02,
  pinnedPerCommunicatorGb: gib(1.25),
  hostWeightAllocationGb: nextPowerOfTwoGb,
  // Latent attention backends allocate in blocks of up to 128 tokens, and the largest keeps the floor safe.
  paging: { attentionBlockTokens: { standard: 16, latent: 128 }, alignStatePagesPerGroup: 2, groupSizeRatio: 1.5 },
};

// Ollama keeps its own accounting: one shared server per node, weights and KV only.
const OLLAMA: EngineProfile = {
  gpuPerRankGb: { whole: 0, split: 0 },
  gpuSpeculativeGb: 0,
  hostLeaderGb: 0,
  hostFollowerGb: 0,
  hostVisionGb: 0,
  hostPerImageInFlightGb: 0,
  pinnedPerCommunicatorGb: 0,
  hostWeightAllocationGb: (gb) => gb,
  paging: { attentionBlockTokens: { standard: 16, latent: 16 }, alignStatePagesPerGroup: 2, groupSizeRatio: 1.5 },
};

// Newest first. A node on a version older than every entry, or one that reports none, gets the newest.
export const ENGINE_PROFILES: Record<Engine, readonly { since: string; profile: EngineProfile }[]> = {
  vllm: [{ since: "0.0.0", profile: VLLM_0_31 }],
  ollama: [{ since: "0.0.0", profile: OLLAMA }],
};

export function engineProfile(engine: Engine, version?: string): EngineProfile {
  const profiles = ENGINE_PROFILES[engine];
  const matching = version ? profiles.find((candidate) => satisfiesMinVersion(version, candidate.since)) : undefined;
  return (matching ?? profiles[0]!).profile;
}

export type RankFootprint = { node: number; gpuGb: number; hostGb: number };

export type Footprint = {
  ranks: RankFootprint[];
  nodes: { gpuGb: number; hostGb: number }[];
  gpuGb: number;
  hostGb: number;
};

export type FootprintRequest = {
  layout: Layout;
  kvCacheGb: number;
  imagesInFlight: number;
  profile: EngineProfile;
};

export function imagesInFlight(entry: FootprintEntry, gpus: GpuInfo[], kvCacheGb: number): number {
  if (!entry.tags.includes("vision")) {
    return 0;
  }
  return estimateConcurrency({ sizing: entry.sizing, engine: "vllm" }, { gpus }, { kvCacheGb })?.sweetSpot ?? 0;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

// Undefined when the model cannot be split across this many cards.
export function deploymentFootprint(entry: FootprintEntry, request: FootprintRequest): Footprint | undefined {
  const { layout, kvCacheGb, imagesInFlight, profile } = request;
  const { sizing } = entry;
  const ranks = layoutRanks(layout);
  const kvShare = kvCacheSharePerCard(sizing, ranks);
  if (kvShare === undefined) {
    return undefined;
  }

  const hostWeightGb = sizing.hostWeightGb ?? 0;
  const speculative = entry.engineArgs?.includes("--speculative-config") ?? false;
  const vision = entry.tags.includes("vision");
  const communicators = sizing.activeWeightGb === undefined ? 1 : 2;

  const gpuGb = (sizing.weightGb - hostWeightGb) / ranks
    + kvCacheGb * kvShare
    + (ranks > 1 ? profile.gpuPerRankGb.split : profile.gpuPerRankGb.whole)
    + (speculative ? profile.gpuSpeculativeGb : 0);
  const sharedHostGb = profile.hostWeightAllocationGb(hostWeightGb / ranks)
    + (layout.nodes > 1 ? communicators * profile.pinnedPerCommunicatorGb : 0);
  const leaderHostGb = profile.hostLeaderGb
    + (vision ? profile.hostVisionGb + imagesInFlight * profile.hostPerImageInFlightGb : 0);

  const rankFootprints = Array.from({ length: ranks }, (_, rank): RankFootprint => ({
    node: Math.floor(rank / layout.cardsPerNode),
    gpuGb,
    hostGb: sharedHostGb + (rank === 0 ? leaderHostGb : profile.hostFollowerGb),
  }));
  const nodes = Array.from({ length: layout.nodes }, (_, node) => {
    const onNode = rankFootprints.filter((rank) => rank.node === node);
    return { gpuGb: sum(onNode.map((rank) => rank.gpuGb)), hostGb: sum(onNode.map((rank) => rank.hostGb)) };
  });
  return {
    ranks: rankFootprints,
    nodes,
    gpuGb: sum(nodes.map((node) => node.gpuGb)),
    hostGb: sum(nodes.map((node) => node.hostGb)),
  };
}

export type LayoutOption = { layout: Layout; allowed: true } | { layout: Layout; allowed: false; reason: string };

type LayoutContext = { entry: FootprintEntry; layout: Layout; ranks: number; vendor: string };

const PLACEMENT_LIMIT_CHECKS: { [Kind in PlacementLimitFields["limit"]]: (limit: Extract<PlacementLimitFields, { limit: Kind }>, context: LayoutContext) => boolean } = {
  nodes: (limit, { layout }) => layout.nodes <= limit.max,
  cards: (limit, { ranks }) => ranks <= limit.max,
  splitSizes: (limit, { ranks }) => ranks === 1 || limit.values.includes(ranks),
};

function limitAllows(limit: PlacementLimitFields, context: LayoutContext): boolean {
  return (PLACEMENT_LIMIT_CHECKS[limit.limit] as (limit: PlacementLimitFields, context: LayoutContext) => boolean)(limit, context);
}

// Each returns why the layout is ruled out, or undefined. Capabilities unlock only once the facts
// they need are stated, so a missing fact rules out the wider layout rather than guessing.
const LAYOUT_RULES: ((context: LayoutContext) => string | undefined)[] = [
  ({ ranks, vendor }) => ranks > 1 && !runsTensorParallel(vendor)
    ? `${vendor} GPUs run an installation on one card`
    : undefined,
  ({ entry, ranks }) => {
    const { attentionHeads, kvHeads } = entry.sizing;
    if (ranks === 1 || kvCacheSharePerCard(entry.sizing, ranks) !== undefined) {
      return undefined;
    }
    return attentionHeads === undefined || kvHeads === undefined
      ? "The entry states no head counts, so it runs on one card"
      : `${attentionHeads} attention and ${kvHeads} key/value heads do not split across ${ranks} cards`;
  },
  ({ entry, layout }) => layout.nodes > 1 && entry.sizing.hostWeightGb === undefined
    ? "The entry has not been checked across machines yet, so it runs on one machine"
    : undefined,
  ({ entry, layout }) => {
    const { attentionLayers, stateLayers, stateBytesPerSequence } = entry.sizing;
    const missing = attentionLayers === undefined || (stateBytesPerSequence !== undefined && stateLayers === undefined);
    return layout.nodes > 1 && missing ? "The entry states no layer counts, so it runs on one machine" : undefined;
  },
];

export function layoutOptions(
  entry: FootprintEntry,
  { maxCardsPerNode, maxNodes, vendor, engineVersion }: { maxCardsPerNode: number; maxNodes: number; vendor: string; engineVersion?: string },
): LayoutOption[] {
  // Without a known version every limit applies, since an expired one only narrows the choice.
  const limits = entry.placement.limits.filter((limit) =>
    !limit.engineRange || !engineVersion || matchesVersionRange(engineVersion, limit.engineRange));
  const options: LayoutOption[] = [];
  for (let nodes = 1; nodes <= maxNodes; nodes++) {
    for (let cardsPerNode = 1; cardsPerNode <= maxCardsPerNode; cardsPerNode++) {
      const layout = { cardsPerNode, nodes };
      const context = { entry, layout, ranks: layoutRanks(layout), vendor };
      const reason = LAYOUT_RULES.map((rule) => rule(context)).find((found) => found !== undefined)
        ?? limits.find((limit) => !limitAllows(limit, context))?.reason;
      options.push(reason === undefined ? { layout, allowed: true } : { layout, allowed: false, reason });
    }
  }
  return options;
}
