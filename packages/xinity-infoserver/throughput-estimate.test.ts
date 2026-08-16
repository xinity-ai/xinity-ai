import { describe, it, expect } from "bun:test";
import { estimateThroughput } from "./throughput-estimate";

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
