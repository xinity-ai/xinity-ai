/**
 * How fast one model runs on one node. Pure arithmetic over the entry's own figures and
 * the GPU class table, with no IO, the same contract node-compat.ts keeps for placement.
 *
 * Decode is bound by memory bandwidth, because every weight that participates is read
 * once per generated token. Prefill is bound by compute, because a whole prompt is
 * processed in one pass. Concurrency needs a third input, the cache a deployment was
 * given, which is a property of neither the model nor the card, so it is a separate call.
 */
import { classifyGpu, type GpuClass } from "./gpu-classes";
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

const PRECISION_SPEEDUP: Record<"fp8" | "fp4", number> = { fp8: 2, fp4: 4 };

/**
 * Tensor cores roughly double their rate per halving of the datatype, and an engine runs
 * a quantized model's matrix multiplies at the narrowest width the weights and the card
 * both support. Scoring against fp16 alone would give a 4-bit model on Blackwell a
 * quarter of the compute it actually gets.
 */
function effectiveTflops(gpu: GpuClass, weightBits: number | undefined): number {
  if (gpu.lowPrecision === null || weightBits === undefined || weightBits >= 16) {
    return gpu.fp16Tflops;
  }
  const usable = weightBits <= 4 && gpu.lowPrecision === "fp4" ? "fp4" : "fp8";
  return gpu.fp16Tflops * PRECISION_SPEEDUP[usable];
}

type ServingContext = {
  gpu: GpuClass;
  cardCount: number;
  efficiency: { decode: number; prefill: number };
};

function servingContext(engine: string, node: Pick<NodeCapability, "gpus">): ServingContext | undefined {
  const [firstGpu] = node.gpus;
  if (!firstGpu) {
    return undefined;
  }
  return {
    gpu: classifyGpu(firstGpu.name),
    cardCount: node.gpus.every(other => other.name === firstGpu.name) ? node.gpus.length : 1,
    efficiency: ENGINE_EFFICIENCY[engine] ?? UNKNOWN_ENGINE_EFFICIENCY,
  };
}

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
  const context = servingContext(model.engine, node);
  if (!context) {
    return undefined;
  }

  const { gpu, cardCount, efficiency } = context;
  const { weightGb, activeWeightGb, weightBits } = model.sizing;
  const readPerTokenGb = activeWeightGb ?? weightGb;

  const decodeTps =
    (gpu.bandwidthGbs * cardCount * efficiency.decode) / readPerTokenGb;

  const activeParams = weightBits === undefined
    ? undefined
    : (readPerTokenGb * BYTES_PER_GB * BITS_PER_BYTE) / weightBits;

  const prefillTps = activeParams === undefined
    ? undefined
    : (effectiveTflops(gpu, weightBits) * cardCount * 1e12 * efficiency.prefill)
      / (FLOPS_PER_PARAM_PER_TOKEN * activeParams);

  return {
    decodeTps,
    prefillTps,
    basis: gpu.known ? "known-gpu" : "default-gpu",
  };
}

/**
 * Tokens a live sequence is assumed to hold on average. Paged attention allocates blocks
 * as a sequence grows rather than reserving its context up front, so the cache holds far
 * more requests than the full-context arithmetic suggests, and a cap set from that
 * arithmetic would idle most of the hardware. Deliberately well under a typical
 * conversation's configured window, since overshooting costs preemption and recompute.
 */
const ASSUMED_LIVE_TOKENS = 4096;

/**
 * Share of a deployment's peak aggregate throughput the sweet spot aims for. Batching
 * amortizes the weight read over more tokens, so total throughput climbs towards a
 * ceiling set by KV traffic alone and never quite reaches it. Chasing the last quarter
 * costs three times the batch size, and every extra sequence is cache pressure that
 * turns into preemption.
 *
 * Reaching fraction f takes a batch of f / (1 - f) times the weight-to-KV ratio, and
 * leaves one request running at (1 - f) of its solo speed, the two being complementary.
 */
const TARGET_AGGREGATE_FRACTION = 0.75;

/** What a deployment was actually given, as opposed to what the entry says the model supports. */
export type KvAllocation = {
  /** The cache the engine gets to hold sequences in, which is what caps concurrency. */
  kvCacheGb: number;
  /** Defaults to the entry's maxContextLength when the deployment sets no lower limit. */
  contextLength?: number;
  /** Overrides ASSUMED_LIVE_TOKENS where a deployment's traffic shape is actually known. */
  typicalRequestTokens?: number;
};

export type ConcurrencyEstimate = {
  /**
   * Requests that fit with every one of them holding its full context, so the count a
   * deployment can always honour. Never below one: vLLM refuses to start unless a single
   * sequence at max_model_len fits, so a deployment that runs at all serves one.
   */
  fullContextConcurrency: number;
  /**
   * Requests that fit at a typical live sequence length. Higher than the full-context
   * count, and the honest figure for a cap, because exceeding the cache costs preemption
   * rather than a refusal to start. Hybrid models are the exception, since their
   * per-sequence state is allocated up front, which is what stateBytesPerSequence covers.
   */
  workingSetConcurrency: number;
  /**
   * Batch size that reaches TARGET_AGGREGATE_FRACTION of maxAggregateTps. Usually the
   * binding limit, and the reason a card with little bandwidth is done batching long
   * before its cache is full.
   */
  kvBandwidthKnee: number;
  /**
   * Batch size past which the matrix multiplies outgrow the weight reads they are batched
   * against. Absent when the entry states no weightBits.
   */
  computeKnee: number | undefined;
  /** What to cap the engine at, whichever limit binds first. */
  sweetSpot: number;
  /** Tokens per second one request still gets at the sweet spot, against decodeTps alone. */
  decodeTpsAtSweetSpot: number;
  /** Tokens per second the whole deployment generates at the sweet spot. */
  aggregateTps: number;
  /**
   * Tokens per second an unbounded batch would approach, once the weight read is spread
   * so thin that only KV traffic remains. Quantization does not move it, so it is the
   * figure that says whether more concurrency is worth anything at all.
   */
  maxAggregateTps: number;
  basis: "known-gpu" | "default-gpu";
};

/**
 * Undefined when the entry states no kvBytesPerToken. minKvCacheGb is not a substitute:
 * it was authored for a token budget the entry never records, so dividing by it would
 * produce a confident number with nothing behind it.
 *
 * The two limits are unrelated in kind. The KV one is arithmetic over figures we hold
 * exactly, against an assumption about how much of its context a request really holds.
 * The compute one is a property of the card, where per-token weight reads stop dominating
 * the matrix multiplies batched against them.
 */
export function estimateConcurrency(
  model: Pick<Model, "sizing" | "engine">,
  node: Pick<NodeCapability, "gpus">,
  allocation: KvAllocation,
): ConcurrencyEstimate | undefined {
  const throughput = estimateThroughput(model, node);
  const context = servingContext(model.engine, node);
  const { weightGb, activeWeightGb, kvBytesPerToken, stateBytesPerSequence, maxContextLength, attentionWindow, weightBits } = model.sizing;
  if (!throughput || !context || kvBytesPerToken === undefined) {
    return undefined;
  }

  const configuredContext = Math.min(
    allocation.contextLength ?? maxContextLength,
    attentionWindow ?? Infinity,
  );
  const liveTokens = Math.min(configuredContext, allocation.typicalRequestTokens ?? ASSUMED_LIVE_TOKENS);
  const stateBytes = stateBytesPerSequence ?? 0;
  const cacheBytes = allocation.kvCacheGb * BYTES_PER_GB;

  const fullContextConcurrency = Math.max(
    1,
    Math.floor(cacheBytes / (configuredContext * kvBytesPerToken + stateBytes)),
  );
  const bytesPerRequest = liveTokens * kvBytesPerToken + stateBytes;
  const workingSetConcurrency = Math.max(1, Math.floor(cacheBytes / bytesPerRequest));

  const activeWeightBytes = (activeWeightGb ?? weightGb) * BYTES_PER_GB;
  const kvBandwidthKnee = Math.max(
    1,
    Math.floor(
      (TARGET_AGGREGATE_FRACTION / (1 - TARGET_AGGREGATE_FRACTION) * activeWeightBytes) / bytesPerRequest,
    ),
  );

  const computeKnee = weightBits === undefined ? undefined : computeKneeOf(context, weightBits);
  const sweetSpot = Math.min(workingSetConcurrency, kvBandwidthKnee, computeKnee ?? Infinity);

  const bytesPerSecond =
    context.gpu.bandwidthGbs * context.cardCount * BYTES_PER_GB * context.efficiency.decode;
  const stepSeconds = (activeWeightBytes + sweetSpot * bytesPerRequest) / bytesPerSecond;

  return {
    fullContextConcurrency,
    workingSetConcurrency,
    kvBandwidthKnee,
    computeKnee,
    sweetSpot,
    decodeTpsAtSweetSpot: 1 / stepSeconds,
    aggregateTps: sweetSpot / stepSeconds,
    maxAggregateTps: bytesPerSecond / bytesPerRequest,
    basis: throughput.basis,
  };
}

/**
 * Decode at batch B reads the active weights once and multiplies them against B tokens, so
 * the step is memory bound until B * 2 * params / flops overtakes bytes / bandwidth. The
 * weight bytes cancel out of that comparison and leave bytes per parameter, which is why a
 * 4-bit model reaches the knee at a quarter the batch size of the same model at fp16.
 * Card count cancels too, both sides scaling with it.
 */
function computeKneeOf({ gpu, efficiency }: ServingContext, weightBits: number): number {
  const deviceFlopsPerByte =
    (effectiveTflops(gpu, weightBits) * 1e12 * efficiency.prefill)
    / (gpu.bandwidthGbs * BYTES_PER_GB * efficiency.decode);
  const bytesPerParam = weightBits / BITS_PER_BYTE;
  return Math.max(1, Math.round((bytesPerParam * deviceFlopsPerByte) / FLOPS_PER_PARAM_PER_TOKEN));
}
