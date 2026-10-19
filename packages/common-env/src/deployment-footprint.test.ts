import { describe, expect, test } from "bun:test";
import { chargedAgainstCards, chargedAgainstHostMemory, deploymentFootprint, engineProfile, FOOTPRINT_PART_MEMORY, layoutOptions, maxNumSeqs, sharesHostMemory, type FootprintEntry, type Layout } from "./deployment-footprint";
import { ModelSizing } from "./model-catalog/definitions/model-definition";

const GB_PER_GIB = 1.073741824;
const toGib = (gb: number) => gb / GB_PER_GIB;
const vllm = engineProfile("0.31.1");

function entry(sizing: Record<string, unknown>, extra: Partial<FootprintEntry> = {}): FootprintEntry {
  return { sizing: ModelSizing.parse({ maxContextLength: 262144, minKvCacheGb: 1, ...sizing }), tags: [], placement: { limits: [] }, ...extra };
}

const oneNode: Layout = { cardsPerNode: 1, nodes: 1 };
const twoNodes: Layout = { cardsPerNode: 1, nodes: 2 };

// Measured on the GX10 pair, 2026-10-15 (GiB). Weights are the logged "Model loading took" figures.
const measured = [
  {
    run: "Qwen3.8 27B NVFP4, one node, 16 images in flight",
    entry: entry({ weightGb: 24.18 * GB_PER_GIB, attentionHeads: 24, kvHeads: 4 }, { tags: ["vision"] }),
    layout: oneNode, kvCacheGb: 17.58, imagesInFlight: 16,
    gpuGib: [41.80], hostGib: [9.99],
  },
  {
    run: "Qwen3.8 27B NVFP4, one node, 300 images in flight",
    entry: entry({ weightGb: 24.18 * GB_PER_GIB, attentionHeads: 24, kvHeads: 4 }, { tags: ["vision"] }),
    layout: oneNode, kvCacheGb: 17.58, imagesInFlight: 300,
    gpuGib: [43.04], hostGib: [14.68],
  },
  {
    run: "DeepSeek R1 Distill 32B BF16, one node, text",
    entry: entry({ weightGb: 61.07 * GB_PER_GIB }),
    layout: oneNode, kvCacheGb: 8.7, imagesInFlight: 0,
    gpuGib: [71.03], hostGib: [3.77],
  },
  {
    run: "Qwen3.8 27B NVFP4 across two nodes",
    entry: entry({ weightGb: 24.18 * GB_PER_GIB, attentionHeads: 24, kvHeads: 4 }, { tags: ["vision"] }),
    layout: twoNodes, kvCacheGb: 17.58, imagesInFlight: 41,
    gpuGib: [22.06, 22.12], hostGib: [9.72, 6.21],
  },
  {
    run: "Nemotron 3 Super FP8 across two nodes, MoE, text",
    entry: entry({ weightGb: 2 * 60.14 * GB_PER_GIB, activeWeightGb: 12, attentionHeads: 32, kvHeads: 2 }),
    layout: twoNodes, kvCacheGb: 3, imagesInFlight: 0,
    gpuGib: [64.30, 64.30], hostGib: [6.34, 4.81],
  },
  {
    run: "Qwen3.8 Flash Next NVFP4 + MTP across two nodes, n-gram table on the host",
    entry: entry(
      { weightGb: 2 * 39.26 * GB_PER_GIB + 51.2, hostWeightGb: 51.2, activeWeightGb: 10, attentionHeads: 24, kvHeads: 2 },
      { tags: ["vision"], engineArgs: ["--speculative-config", "{\"method\":\"mtp\"}"] },
    ),
    layout: twoNodes, kvCacheGb: 8.5, imagesInFlight: 30,
    gpuGib: [47.30], hostGib: [40.0],
  },
];

describe("deploymentFootprint against measured runs", () => {
  for (const run of measured) {
    test(`covers ${run.run}, and charges at most 2 GiB more GPU per rank`, () => {
      const footprint = deploymentFootprint(run.entry, { layout: run.layout, kvCacheGb: run.kvCacheGb, imagesInFlight: run.imagesInFlight, profile: vllm })!;
      run.gpuGib.forEach((gpuGib, rank) => {
        expect(toGib(footprint.ranks[rank]!.gpuGb)).toBeGreaterThanOrEqual(gpuGib);
        expect(toGib(footprint.ranks[rank]!.gpuGb)).toBeLessThanOrEqual(gpuGib + 2);
      });
      run.hostGib.forEach((hostGib, rank) => {
        expect(toGib(footprint.ranks[rank]!.hostGb)).toBeGreaterThanOrEqual(hostGib);
      });
    });
  }

  test("charges a node the sum of its ranks, and the host table per rank rounded to a power of two", () => {
    const flash = measured.at(-1)!;
    const footprint = deploymentFootprint(flash.entry, { layout: twoNodes, kvCacheGb: 8.5, imagesInFlight: 0, profile: vllm })!;
    expect(footprint.nodes).toHaveLength(2);
    expect(footprint.nodes[1]!.hostGb).toBe(footprint.ranks[1]!.hostGb);
    // 25.6 GB per rank, allocated as 2^35 bytes
    expect(footprint.ranks[1]!.hostGb).toBeGreaterThanOrEqual(34.359);
  });

  test("names what each node's charge is made of, adding up to its GPU and host totals", () => {
    const flash = measured.at(-1)!;
    const footprint = deploymentFootprint(flash.entry, { layout: twoNodes, kvCacheGb: 8.5, imagesInFlight: 30, profile: vllm })!;
    const [leader, follower] = footprint.nodes;
    expect(leader!.parts.map(({ part }) => part)).toEqual(["weights", "kvCache", "engine", "speculative", "hostWeights", "communicators", "engineProcess", "imageInput"]);
    expect(follower!.parts.map(({ part }) => part)).not.toContain("imageInput");
    for (const node of footprint.nodes) {
      const total = (memory: "gpu" | "host") => node.parts.filter(({ part }) => FOOTPRINT_PART_MEMORY[part] === memory).reduce((sum, { gb }) => sum + gb, 0);
      expect(total("gpu")).toBeCloseTo(node.gpuGb);
      expect(total("host")).toBeCloseTo(node.hostGb);
    }
  });

  test("has no footprint for a split the heads cannot make", () => {
    expect(deploymentFootprint(entry({ weightGb: 10 }), { layout: twoNodes, kvCacheGb: 1, imagesInFlight: 0, profile: vllm })).toBeUndefined();
  });
});

describe("layoutOptions", () => {
  const options = (e: FootprintEntry, context: { maxCardsPerNode?: number; maxNodes?: number; vendor?: string; engineVersion?: string } = {}) =>
    layoutOptions(e, { maxCardsPerNode: 1, maxNodes: 2, vendor: "nvidia", ...context });
  const at = (list: ReturnType<typeof options>, layout: Layout) =>
    list.find((option) => option.layout.cardsPerNode === layout.cardsPerNode && option.layout.nodes === layout.nodes)!;
  const checked = { weightGb: 50, attentionHeads: 32, kvHeads: 8, hostWeightGb: 0, attentionLayers: 48 };

  test("keeps an entry on one machine until it is checked across machines", () => {
    const list = options(entry({ weightGb: 50, attentionHeads: 32, kvHeads: 8, attentionLayers: 48 }));
    expect(at(list, oneNode).allowed).toBe(true);
    expect(at(list, twoNodes)).toMatchObject({ allowed: false, reason: expect.stringContaining("checked across machines") });
  });

  test("allows two machines once hostWeightGb and the layer counts are stated, 0 included", () => {
    expect(at(options(entry(checked)), twoNodes).allowed).toBe(true);
  });

  test("keeps a hybrid on one machine while its state layers are missing", () => {
    const hybrid = entry({ ...checked, stateBytesPerSequence: 1_000_000 });
    expect(at(options(hybrid), twoNodes)).toMatchObject({ allowed: false, reason: expect.stringContaining("layer counts") });
  });

  test("applies a limit only on the engine releases it names, and on every release when the version is unknown", () => {
    const limited = entry(checked, { placement: { limits: [{ limit: "nodes", max: 1, reason: "Tables cannot be split yet.", engineRange: "<0.33.0" }] } });
    expect(at(options(limited, { engineVersion: "0.31.1" }), twoNodes)).toMatchObject({ allowed: false, reason: "Tables cannot be split yet." });
    expect(at(options(limited, { engineVersion: "0.33.0" }), twoNodes).allowed).toBe(true);
    expect(at(options(limited), twoNodes).allowed).toBe(false);
  });

  test("offers only the split sizes a splitSizes limit names", () => {
    const limited = entry(checked, { placement: { limits: [{ limit: "splitSizes", values: [1, 2, 4], reason: "FP8 blocks." }] } });
    const list = options(limited, { maxCardsPerNode: 8, maxNodes: 1 });
    expect(list.filter((option) => option.allowed).map((option) => option.layout.cardsPerNode)).toEqual([1, 2, 4]);
  });

  test("names the vendor that cannot split", () => {
    expect(at(options(entry(checked), { maxCardsPerNode: 2, maxNodes: 1, vendor: "intel" }), { cardsPerNode: 2, nodes: 1 }))
      .toMatchObject({ allowed: false, reason: expect.stringContaining("intel") });
  });
});

describe("derived KV floor", () => {
  // DeepSeek R1 Distill 32B at 32,768 tokens: vLLM refused 8.59 GB ("estimated maximum model length
  // is 32752") and started at 8.7.
  test("asks for the block vLLM keeps beyond the context", () => {
    const sizing = ModelSizing.parse({ weightGb: 65.5, kvBytesPerToken: 262144, maxContextLength: 32768 });
    expect(sizing.minKvCacheGb).toBeGreaterThan(8.59);
    expect(sizing.minKvCacheGb).toBeLessThanOrEqual(8.7);
  });
});

describe("maxNumSeqs", () => {
  const gpus = [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 4090", vramMb: 24576 }];
  const sizing = { weightGb: 14, minKvCacheGb: 4, maxContextLength: 32768, weightBits: 16, kvBytesPerToken: 131072 };

  test("takes the entry's own --max-num-seqs", () => {
    expect(maxNumSeqs({ sizing, engineArgs: ["--max-num-seqs", "12"] }, gpus, 8)).toBe(12);
    expect(maxNumSeqs({ sizing, engineArgs: ["--max-num-seqs=12"] }, gpus, 8)).toBe(12);
  });

  test("stays inside what the allocated cache holds, so vllm never rejects it", () => {
    const seqs = maxNumSeqs({ sizing }, gpus, 8);
    expect(seqs).toBeGreaterThan(0);
    expect(seqs).toBeLessThanOrEqual(Math.floor((8 * 1e9) / (131072 * 4096)));
  });

  test("charges a hybrid model for its per-sequence state, lowering it", () => {
    // Few full-attention layers, so the fixed state dominates in a tight cache.
    const attentionOnly = { ...sizing, kvBytesPerToken: 24576 };
    const hybrid = { ...attentionOnly, stateBytesPerSequence: 20_000_000 };
    expect(maxNumSeqs({ sizing: hybrid }, gpus, 3)).toBeLessThan(maxNumSeqs({ sizing: attentionOnly }, gpus, 3));
  });

  test("without a card to estimate against, runs as many full-context requests as the cache holds", () => {
    expect(maxNumSeqs({ sizing }, [], 8)).toBe(Math.floor((8 * 1e9) / (32768 * 131072)));
  });

  test("without a kv cost per token, runs one at a time rather than the engine's default", () => {
    const { kvBytesPerToken: _, ...withoutPerToken } = sizing;
    expect(maxNumSeqs({ sizing: withoutPerToken }, gpus, 8)).toBe(1);
  });
});

describe("charging a machine's memory", () => {
  const charge = { gpuGb: 40, hostGb: 10 };

  test("keeps the cards and host memory apart where a GPU has memory of its own, and one pool where none does", () => {
    const discrete = sharesHostMemory([{ vramMb: 46080 }]);
    expect([chargedAgainstCards(charge, discrete), chargedAgainstHostMemory(charge, discrete)]).toEqual([40, 10]);
    const shared = sharesHostMemory([{ vramMb: 0 }]);
    expect([chargedAgainstCards(charge, shared), chargedAgainstHostMemory(charge, shared)]).toEqual([50, 50]);
    expect(sharesHostMemory([])).toBe(true);
  });
});
