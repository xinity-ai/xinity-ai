/**
 * Per-GPU figures that decide how fast a model runs, matched by substring against the
 * name the daemon detects. Decode speed is bound by memory bandwidth and prefill by
 * compute, so those are the two numbers worth carrying.
 *
 * Coarse figures are acceptable, the same tradeoff the TDP table in the daemon makes:
 * a card that is 10% off still puts an estimate in the right bracket, and `known`
 * lets a consumer stay silent rather than print a figure for a card nobody listed.
 */

export type GpuClass = {
  /** Peak memory bandwidth in GB/s. Sets the ceiling on single-request decode speed. */
  bandwidthGbs: number;
  /** Dense FP16 throughput in TFLOPS, without sparsity. Sets the ceiling on prefill. */
  fp16Tflops: number;
  /** Narrowest datatype with hardware acceleration, which roughly doubles prefill per step down. */
  lowPrecision: "fp8" | "fp4" | null;
  /** False when no pattern matched and the pessimistic default was used. */
  known: boolean;
};

/** First match wins, so a pattern must never precede a longer one that contains it. */
const GPU_CLASSES: [pattern: string, gpu: Omit<GpuClass, "known">][] = [
  ["mi300x", { bandwidthGbs: 5300, fp16Tflops: 1307, lowPrecision: "fp8" }],
  ["h200", { bandwidthGbs: 4800, fp16Tflops: 989, lowPrecision: "fp8" }],
  ["h100", { bandwidthGbs: 2700, fp16Tflops: 870, lowPrecision: "fp8" }],
  ["a100", { bandwidthGbs: 1900, fp16Tflops: 312, lowPrecision: null }],
  ["rtx pro 6000", { bandwidthGbs: 1792, fp16Tflops: 126, lowPrecision: "fp4" }],
  ["rtx 6000", { bandwidthGbs: 960, fp16Tflops: 91, lowPrecision: "fp8" }],
  ["a6000", { bandwidthGbs: 768, fp16Tflops: 39, lowPrecision: null }],
  ["l40", { bandwidthGbs: 864, fp16Tflops: 181, lowPrecision: "fp8" }],
  ["rtx 5090", { bandwidthGbs: 1792, fp16Tflops: 105, lowPrecision: "fp4" }],
  ["rtx 4090", { bandwidthGbs: 1008, fp16Tflops: 83, lowPrecision: "fp8" }],
  ["rtx 3090", { bandwidthGbs: 936, fp16Tflops: 36, lowPrecision: null }],
  // Unified memory, so bandwidth is the system figure rather than a dedicated bus.
  ["gb10", { bandwidthGbs: 273, fp16Tflops: 125, lowPrecision: "fp4" }],
];

/** Deliberately low. An underestimate reads as a cautious figure; an overestimate reads as a promise. */
const UNKNOWN_GPU: Omit<GpuClass, "known"> = { bandwidthGbs: 500, fp16Tflops: 40, lowPrecision: null };

export function classifyGpu(name: string): GpuClass {
  const lowered = name.toLowerCase();
  const matched = GPU_CLASSES.find(([pattern]) => lowered.includes(pattern))?.[1];
  return { ...(matched ?? UNKNOWN_GPU), known: matched !== undefined };
}

/** Exported for the ordering check; the table is otherwise private. */
export const gpuClassPatterns = GPU_CLASSES.map(([pattern]) => pattern);
