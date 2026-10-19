import { kvCacheSharePerCard } from "../tensor-parallel";

const BYTES_PER_GB = 1e9;

export type KvPaging = {
  attentionBlockTokens: { standard: number; latent: number };
  alignStatePagesPerGroup: number;
  groupSizeRatio: number;
};

type KvFloorSizing = {
  kvBytesPerToken?: number;
  stateBytesPerSequence?: number;
  attentionLayers?: number;
  stateLayers?: number;
  attentionHeads?: number;
  kvHeads?: number;
  mlaAttention?: boolean;
  maxContextLength: number;
  attentionWindow?: number;
};

export type KvFloorLayout = { ranks: number; speculativeTokens: number };

// Summed over all ranks, and rounded up: a hair under the floor is what stops vLLM booting.
export function kvCacheFloorGb(sizing: KvFloorSizing, { ranks, speculativeTokens }: KvFloorLayout, paging: KvPaging): number | undefined {
  const { kvBytesPerToken, stateBytesPerSequence, attentionLayers, stateLayers } = sizing;
  const kvShare = kvCacheSharePerCard(sizing, ranks);
  if (kvBytesPerToken === undefined || kvShare === undefined) {
    return undefined;
  }
  const blockTokens = sizing.mlaAttention ? paging.attentionBlockTokens.latent : paging.attentionBlockTokens.standard;
  const contextTokens = Math.min(sizing.maxContextLength, sizing.attentionWindow ?? Infinity);
  const rankBytesPerToken = kvBytesPerToken * kvShare;
  const rankStateBytes = (stateBytesPerSequence ?? 0) / ranks;
  const rankBytes = stateBytesPerSequence !== undefined && attentionLayers !== undefined && stateLayers !== undefined
    ? pagedHybridBytes(rankBytesPerToken / attentionLayers, rankStateBytes / stateLayers, { attentionLayers, stateLayers }, contextTokens, speculativeTokens, blockTokens, paging)
    : attentionBytes(rankBytesPerToken, contextTokens, blockTokens) + rankStateBytes;
  return Math.ceil((rankBytes / kvShare / BYTES_PER_GB) * 100) / 100;
}

// Whole blocks plus the null block the pool holds back. For a hybrid without layer counts the state
// is added unpadded, which can fall slightly short of what vLLM pages.
function attentionBytes(bytesPerToken: number, contextTokens: number, blockTokens: number): number {
  return bytesPerToken * (Math.ceil(contextTokens / blockTokens) + 1) * blockTokens;
}

// vLLM's grouping, which charges every group the full size, padding layers included.
function groupSize(attentionLayers: number, stateLayers: number, ratio: number): number {
  const smaller = Math.min(attentionLayers, stateLayers);
  const larger = Math.max(attentionLayers, stateLayers);
  return larger < ratio * smaller ? larger : smaller;
}

function pagedHybridBytes(
  attentionBytesPerTokenPerLayer: number,
  stateBytesPerLayer: number,
  { attentionLayers, stateLayers }: { attentionLayers: number; stateLayers: number },
  contextTokens: number,
  speculativeTokens: number,
  blockTokens: number,
  paging: KvPaging,
): number {
  const blockTokensCoveringState = blockTokens * Math.ceil(stateBytesPerLayer / (blockTokens * attentionBytesPerTokenPerLayer));
  const pageBytes = blockTokensCoveringState * attentionBytesPerTokenPerLayer;
  const group = groupSize(attentionLayers, stateLayers, paging.groupSizeRatio);
  const poolBlocks = Math.ceil(attentionLayers / group) * Math.ceil(contextTokens / blockTokensCoveringState)
    + Math.ceil(stateLayers / group) * (paging.alignStatePagesPerGroup + speculativeTokens)
    + 1;
  return poolBlocks * group * pageBytes;
}
