/**
 * How fast one model runs on one node. Pure arithmetic over the entry's own figures and
 * the GPU class table, with no IO, the same contract node-compat.ts keeps for placement.
 *
 * Decode is bound by memory bandwidth, because every weight that participates is read
 * once per generated token. Prefill is bound by compute, because a whole prompt is
 * processed in one pass. Concurrency is deliberately not answered here. It follows from
 * the cache a deployment was given, which is a property of neither the model nor the card.
 */
import { classifyGpu } from "./gpu-classes";
import type { Model } from "./definitions/model-definition";
import type { NodeCapability } from "./node-compat";

const BYTES_PER_GB = 1e9;
const BITS_PER_BYTE = 8;
const FLOPS_PER_PARAM_PER_TOKEN = 2;

/**
 * Fractions of peak the engines actually reach. Decode gets close to the bandwidth
 * ceiling, while prefill stays well under half of peak dense FLOPS on real prompts.
 * Both are placeholders until observed throughput can be fitted against them.
 */
const ENGINE_EFFICIENCY: Record<string, { decode: number; prefill: number }> = {
  vllm: { decode: 0.8, prefill: 0.4 },
  ollama: { decode: 0.7, prefill: 0.3 },
};

const UNKNOWN_ENGINE_EFFICIENCY = { decode: 0.7, prefill: 0.3 };

export type ThroughputEstimate = {
  /** Tokens per second one request generates with nothing else running. */
  decodeTps: number;
  /** Tokens per second a prompt is consumed at. Absent when the entry states no weightBits. */
  prefillTps: number | undefined;
  /** Lets a caller suppress a figure rather than show one built on the fallback GPU class. */
  basis: "known-gpu" | "default-gpu";
};

/**
 * Undefined for a node with no GPUs, since CPU inference is not modelled here.
 *
 * Multi-GPU scales linearly, and only when every card is the same model. Interconnect is
 * not recorded anywhere, so that is optimistic for PCIe-linked cards and about right for
 * NVLink. A mixed node is treated as a single card of its first GPU's class.
 */
export function estimateThroughput(
  model: Pick<Model, "sizing" | "engine">,
  node: Pick<NodeCapability, "gpus">,
): ThroughputEstimate | undefined {
  const [firstGpu] = node.gpus;
  if (!firstGpu) {
    return undefined;
  }

  const gpu = classifyGpu(firstGpu.name);
  const cardCount = node.gpus.every(other => other.name === firstGpu.name) ? node.gpus.length : 1;
  const efficiency = ENGINE_EFFICIENCY[model.engine] ?? UNKNOWN_ENGINE_EFFICIENCY;

  const { weightGb, activeWeightGb, weightBits } = model.sizing;
  const readPerTokenGb = activeWeightGb ?? weightGb;

  const decodeTps =
    (gpu.bandwidthGbs * cardCount * efficiency.decode) / readPerTokenGb;

  const activeParams = weightBits === undefined
    ? undefined
    : (readPerTokenGb * BYTES_PER_GB * BITS_PER_BYTE) / weightBits;

  const prefillTps = activeParams === undefined
    ? undefined
    : (gpu.fp16Tflops * cardCount * 1e12 * efficiency.prefill)
      / (FLOPS_PER_PARAM_PER_TOKEN * activeParams);

  return {
    decodeTps,
    prefillTps,
    basis: gpu.known ? "known-gpu" : "default-gpu",
  };
}
