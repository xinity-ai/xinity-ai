import { isKnownGpuVendor, type GpuVendor } from "./model-catalog/definitions/model-primitives";

const RUNS_TENSOR_PARALLEL: Record<GpuVendor, boolean> = { nvidia: true, amd: true, intel: false };

export function runsTensorParallel(vendor: string): boolean {
  return isKnownGpuVendor(vendor) && RUNS_TENSOR_PARALLEL[vendor];
}

type TensorParallelSizing = {
  weightGb: number;
  attentionHeads?: number;
  kvHeads?: number;
  mlaAttention?: boolean;
};

type TensorParallelLayout = {
  tensorParallelSize: number;
  perCardWeightGb: number;
  perCardKvCacheGb: number;
};

export function tensorParallelLayout(
  sizing: TensorParallelSizing,
  { tensorParallelSize, kvCacheGb }: { tensorParallelSize: number; kvCacheGb: number },
): TensorParallelLayout | undefined {
  const kvShare = kvCacheSharePerCard(sizing, tensorParallelSize);
  return kvShare === undefined
    ? undefined
    : { tensorParallelSize, perCardWeightGb: sizing.weightGb / tensorParallelSize, perCardKvCacheGb: kvCacheGb * kvShare };
}

// vLLM's own rules: attention heads must divide by the TP size, and KV heads split while there
// are enough of them, then every card holds a copy of one (QKVParallelLinear).
export function kvCacheSharePerCard(sizing: Pick<TensorParallelSizing, "attentionHeads" | "kvHeads" | "mlaAttention">, tensorParallelSize: number): number | undefined {
  if (tensorParallelSize === 1) {
    return 1;
  }
  const { attentionHeads, kvHeads, mlaAttention } = sizing;
  if (attentionHeads === undefined || kvHeads === undefined || attentionHeads % tensorParallelSize !== 0) {
    return undefined;
  }
  if (mlaAttention) {
    return 1;
  }
  if (tensorParallelSize < kvHeads) {
    return kvHeads % tensorParallelSize === 0 ? 1 / tensorParallelSize : undefined;
  }
  return tensorParallelSize % kvHeads === 0 ? 1 / kvHeads : undefined;
}
