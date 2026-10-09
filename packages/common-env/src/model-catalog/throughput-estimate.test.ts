import { describe, it, expect } from "bun:test";
import { estimateThroughput, estimateConcurrency } from "./throughput-estimate";

const gpu = (name: string) => ({ vendor: "nvidia", name, vramMb: 24576 });
const node = (...names: string[]) => ({ gpus: names.map(gpu) });

const dense = {
  engine: "vllm" as const,
  sizing: { weightGb: 14, minKvCacheGb: 4, maxContextLength: 131072, weightBits: 16 },
};

describe("estimateThroughput", () => {
  it("reads only the active weights of a sparse model, so an MoE is not scored as dense", () => {
    const sparse = { ...dense, sizing: { ...dense.sizing, activeWeightGb: 3.5 } };

    const denseTps = estimateThroughput(dense, node("NVIDIA GeForce RTX 4090"))!.decodeTps;
    const sparseTps = estimateThroughput(sparse, node("NVIDIA GeForce RTX 4090"))!.decodeTps;

    expect(sparseTps / denseTps).toBeCloseTo(4, 1);
  });

  it("scales across identical cards but not across mixed ones", () => {
    const pair = estimateThroughput(dense, node("NVIDIA H100 80GB HBM3", "NVIDIA H100 80GB HBM3"))!;
    const mixed = estimateThroughput(dense, node("NVIDIA H100 80GB HBM3", "NVIDIA GeForce RTX 4090"))!;
    const single = estimateThroughput(dense, node("NVIDIA H100 80GB HBM3"))!;

    expect(pair.decodeTps).toBeCloseTo(single.decodeTps * 2, 1);
    expect(mixed.decodeTps).toBeCloseTo(single.decodeTps, 1);
  });

  it("gives no prefill figure when the entry states no weight precision", () => {
    const withoutBits = { ...dense, sizing: { ...dense.sizing, weightBits: undefined } };

    expect(estimateThroughput(withoutBits, node("NVIDIA H100"))!.prefillTps).toBeUndefined();
  });

  it("flags an unlisted card so callers can stay silent, and declines a node with no GPU", () => {
    expect(estimateThroughput(dense, node("NVIDIA GeForce GTX 1080"))!.basis).toBe("default-gpu");
    expect(estimateThroughput(dense, node())).toBeUndefined();
  });
});

/** 32 layers, 8 kv heads, head dim 128, fp16, i.e. 2 * 32 * 8 * 128 * 2. */
const KV_BYTES_PER_TOKEN = 131072;

const served = {
  ...dense,
  sizing: { ...dense.sizing, kvBytesPerToken: KV_BYTES_PER_TOKEN },
};

describe("estimateConcurrency", () => {
  it("declines rather than falling back to minKvCacheGb, whose token basis is unstated", () => {
    const withoutPerToken = { ...dense, sizing: { ...dense.sizing, minKvCacheGb: 40 } };

    expect(estimateConcurrency(withoutPerToken, node("NVIDIA GeForce RTX 4090"), { kvCacheGb: 40 }))
      .toBeUndefined();
  });

  it("caps at the working set rather than at full context, which would idle most of the cache", () => {
    const estimate = estimateConcurrency(served, node("NVIDIA GeForce RTX 4090"), { kvCacheGb: 8, contextLength: 32768 })!;

    expect(estimate.fullContextConcurrency).toBe(1);
    expect(estimate.workingSetConcurrency).toBe(14);
    expect(estimate.sweetSpot).toBe(14);
  });

  it("takes the compute knee where it binds below the working set", () => {
    const roomy = estimateConcurrency(served, node("NVIDIA GeForce RTX 4090"), { kvCacheGb: 40, contextLength: 2048 })!;

    expect(roomy.sweetSpot).toBe(roomy.computeKnee!);
    expect(roomy.workingSetConcurrency).toBeGreaterThan(roomy.computeKnee!);
  });

  it("honours a known traffic shape over the assumed one", () => {
    const allocation = { kvCacheGb: 8, contextLength: 32768 };
    const longer = estimateConcurrency(served, node("NVIDIA GeForce RTX 4090"), { ...allocation, typicalRequestTokens: 16384 })!;

    expect(longer.workingSetConcurrency).toBe(3);
  });

  it("stops charging for context past the attention window", () => {
    const windowed = { ...served, sizing: { ...served.sizing, attentionWindow: 4096 } };
    const allocation = { kvCacheGb: 4, contextLength: 32768 };

    expect(estimateConcurrency(served, node("NVIDIA GeForce RTX 4090"), allocation)!.fullContextConcurrency).toBe(1);
    expect(estimateConcurrency(windowed, node("NVIDIA GeForce RTX 4090"), allocation)!.fullContextConcurrency).toBe(7);
  });

  it("never reports less than one request, since a cache that small stops vllm from starting", () => {
    const starved = estimateConcurrency(served, node("NVIDIA GeForce RTX 4090"), { kvCacheGb: 0.2, contextLength: 131072 })!;

    expect(starved.fullContextConcurrency).toBe(1);
    expect(starved.sweetSpot).toBe(1);
  });

  it("charges a hybrid model for per-sequence state, which no amount of context shortening frees", () => {
    const hybrid = { ...served, sizing: { ...served.sizing, stateBytesPerSequence: 20_000_000 } };
    const allocation = { kvCacheGb: 8, contextLength: 512, typicalRequestTokens: 512 };

    const attentionOnly = estimateConcurrency(served, node("NVIDIA GeForce RTX 4090"), allocation)!;
    const withState = estimateConcurrency(hybrid, node("NVIDIA GeForce RTX 4090"), allocation)!;

    expect(attentionOnly.workingSetConcurrency).toBe(119);
    expect(withState.workingSetConcurrency).toBe(91);
    expect(withState.kvBandwidthKnee).toBeLessThan(attentionOnly.kvBandwidthKnee);
  });

  it("nets weight precision against the datatype the card can run it in", () => {
    const knee = (weightBits: number, card: string) =>
      estimateConcurrency({ ...served, sizing: { ...served.sizing, weightBits } }, node(card), { kvCacheGb: 40, contextLength: 2048 })!.computeKnee!;

    const fp8Card = "NVIDIA GeForce RTX 4090";
    const fp4Card = "NVIDIA GeForce RTX 5090";

    expect(knee(16, fp8Card) / knee(4, fp8Card)).toBeCloseTo(2, 0);
    expect(knee(16, fp4Card) / knee(4, fp4Card)).toBeCloseTo(1, 0);
  });

  it("reaches three quarters of peak aggregate throughput where kv bandwidth binds", () => {
    const allocation = { kvCacheGb: 60, contextLength: 32768, typicalRequestTokens: 8192 };
    const estimate = estimateConcurrency(served, node("NVIDIA GeForce RTX 4090"), allocation)!;

    expect(estimate.sweetSpot).toBe(estimate.kvBandwidthKnee);
    expect(estimate.aggregateTps / estimate.maxAggregateTps).toBeCloseTo(0.75, 1);
  });

  it("leaves a request at what the aggregate target gives up, the two being complementary", () => {
    const allocation = { kvCacheGb: 60, contextLength: 32768, typicalRequestTokens: 8192 };
    const solo = estimateThroughput(served, node("NVIDIA GeForce RTX 4090"))!.decodeTps;
    const estimate = estimateConcurrency(served, node("NVIDIA GeForce RTX 4090"), allocation)!;

    const aggregateShare = estimate.aggregateTps / estimate.maxAggregateTps;
    const soloShare = estimate.decodeTpsAtSweetSpot / solo;

    expect(aggregateShare + soloShare).toBeCloseTo(1, 5);
  });

  it("gives quantization no say in peak aggregate, which only kv traffic sets", () => {
    const allocation = { kvCacheGb: 60, contextLength: 32768 };
    const card = node("NVIDIA GeForce RTX 4090");
    const light = { ...served, sizing: { ...served.sizing, weightGb: 4, weightBits: 4 } };

    const heavy = estimateConcurrency(served, card, allocation)!;
    const quantized = estimateConcurrency(light, card, allocation)!;

    expect(quantized.maxAggregateTps).toBeCloseTo(heavy.maxAggregateTps, 5);
    expect(quantized.kvBandwidthKnee).toBeLessThan(heavy.kvBandwidthKnee);
  });

  it("falls back to the working set alone when the entry states no weight precision", () => {
    const withoutBits = { ...served, sizing: { ...served.sizing, weightBits: undefined } };
    const estimate = estimateConcurrency(withoutBits, node("NVIDIA GeForce RTX 4090"), { kvCacheGb: 40, contextLength: 2048 })!;

    expect(estimate.computeKnee).toBeUndefined();
    expect(estimate.sweetSpot).toBe(estimate.workingSetConcurrency);
  });
});
