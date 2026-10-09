/**
 * Per-GPU hardware figures, matched by substring against the name the daemon detects.
 * Decode speed is bound by memory bandwidth and prefill by compute, so those are the
 * two numbers throughput estimates need. Power draw rides along because it is keyed
 * by the same name and a second table over the same cards would only drift.
 *
 * Coarse figures are acceptable: a card that is 10% off still puts an estimate in the
 * right bracket, and `known` lets a consumer stay silent rather than print a figure
 * for a card nobody listed.
 */

export type GpuClass = {
  /** Peak memory bandwidth in GB/s. Sets the ceiling on single-request decode speed. */
  bandwidthGbs: number;
  /**
   * Dense FP16 throughput in TFLOPS. Vendors headline the 2:4-sparsity figure, which is
   * double this and unreachable by an inference engine, so a new entry needs halving
   * whenever the datasheet says "with sparsity".
   */
  fp16Tflops: number;
  /** Narrowest datatype with hardware acceleration, which roughly doubles prefill per step down. */
  lowPrecision: "fp8" | "fp4" | null;
  /** Board power in watts, used to estimate energy where the driver reports no draw. */
  tdpWatts: number;
  /** False when no pattern matched and the pessimistic default was used. */
  known: boolean;
};

/** First match wins, so a pattern must never precede a longer one that contains it. */
const GPU_CLASSES: [pattern: string, gpu: Omit<GpuClass, "known">][] = [
  ["mi300x", { bandwidthGbs: 5300, fp16Tflops: 1307, lowPrecision: "fp8", tdpWatts: 750 }],
  ["h200", { bandwidthGbs: 4800, fp16Tflops: 495, lowPrecision: "fp8", tdpWatts: 700 }],
  // Between the PCIe and SXM variants on all three figures.
  ["h100", { bandwidthGbs: 2700, fp16Tflops: 430, lowPrecision: "fp8", tdpWatts: 500 }],
  ["a100", { bandwidthGbs: 1900, fp16Tflops: 312, lowPrecision: null, tdpWatts: 400 }],
  ["rtx pro 6000", { bandwidthGbs: 1792, fp16Tflops: 126, lowPrecision: "fp4", tdpWatts: 600 }],
  ["rtx 6000", { bandwidthGbs: 960, fp16Tflops: 91, lowPrecision: "fp8", tdpWatts: 300 }],
  ["a6000", { bandwidthGbs: 768, fp16Tflops: 39, lowPrecision: null, tdpWatts: 300 }],
  ["l40", { bandwidthGbs: 864, fp16Tflops: 181, lowPrecision: "fp8", tdpWatts: 300 }],
  ["rtx 5090", { bandwidthGbs: 1792, fp16Tflops: 105, lowPrecision: "fp4", tdpWatts: 575 }],
  ["rtx 4090", { bandwidthGbs: 1008, fp16Tflops: 83, lowPrecision: "fp8", tdpWatts: 450 }],
  ["rtx 3090", { bandwidthGbs: 936, fp16Tflops: 36, lowPrecision: null, tdpWatts: 350 }],
  // DGX Spark / Ascent GX10 class: unified memory, so bandwidth is the system figure
  // rather than a dedicated bus, and 100 W of the ~140 W whole-system TDP is the board.
  ["gb10", { bandwidthGbs: 273, fp16Tflops: 125, lowPrecision: "fp4", tdpWatts: 100 }],
];

/** Deliberately low. An underestimate reads as a cautious figure. An overestimate reads as a promise. */
const UNKNOWN_GPU: Omit<GpuClass, "known"> = {
  bandwidthGbs: 500,
  fp16Tflops: 40,
  lowPrecision: null,
  tdpWatts: 250,
};

export function classifyGpu(name: string): GpuClass {
  const lowered = name.toLowerCase();
  const matched = GPU_CLASSES.find(([pattern]) => lowered.includes(pattern))?.[1];
  return { ...(matched ?? UNKNOWN_GPU), known: matched !== undefined };
}

/** Exported for the ordering check. The table is otherwise private. */
export const gpuClassPatterns = GPU_CLASSES.map(([pattern]) => pattern);
