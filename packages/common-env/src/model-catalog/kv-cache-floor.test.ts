import { describe, expect, test } from "bun:test";
import { kvCacheFloorGb } from "./kv-cache-floor";
import { engineProfile } from "../deployment-footprint";

const single = { ranks: 1, speculativeTokens: 0 };
const paging = engineProfile("0.31.1").paging;

// Floors bracketed on a GB10 by starting vLLM 0.31 just below and at the value, as recorded in the
// catalog: the derived floor has to fall between the one that aborted and the one that started.
const bracketed = [
  {
    model: "Qwen3.8 27B (block 784)",
    sizing: { kvBytesPerToken: 65536, attentionHeads: 24, kvHeads: 4, stateBytesPerSequence: 154140672, attentionLayers: 16, stateLayers: 48, maxContextLength: 262144 },
    aborted: 17.57, started: 17.58,
  },
  {
    model: "Qwen3.6 35B A3B (block 1056)",
    sizing: { kvBytesPerToken: 20480, attentionHeads: 16, kvHeads: 2, stateBytesPerSequence: 64880640, attentionLayers: 10, stateLayers: 30, maxContextLength: 262144 },
    aborted: 5.53, started: 5.54,
  },
  {
    model: "Nemotron 3 Super 120B (block 8320)",
    sizing: { kvBytesPerToken: 4096, attentionHeads: 32, kvHeads: 2, stateBytesPerSequence: 170393600, attentionLayers: 8, stateLayers: 40, maxContextLength: 262144 },
    aborted: 1.46, started: 1.47,
  },
  {
    model: "DeepSeek R1 Distill 32B, pure attention",
    sizing: { kvBytesPerToken: 262144, attentionHeads: 40, kvHeads: 8, maxContextLength: 32768 },
    aborted: 8.59, started: 8.7,
  },
];

describe("kvCacheFloorGb", () => {
  for (const { model, sizing, aborted, started } of bracketed) {
    test(`lands between the bracketed floors of ${model}`, () => {
      const floor = kvCacheFloorGb(sizing, single, paging)!;
      expect(floor).toBeGreaterThan(aborted);
      expect(floor).toBeLessThanOrEqual(started);
    });
  }

  // Qwen3.8 27B NVFP4 started across two nodes with 8.79 GB per rank.
  test("asks no more per rank across two cards than a run that started", () => {
    expect(kvCacheFloorGb(bracketed[0]!.sizing, { ranks: 2, speculativeTokens: 0 }, paging)! / 2).toBeLessThanOrEqual(8.79);
  });

  test("keeps a state page per speculative token", () => {
    const sizing = bracketed[1]!.sizing;
    expect(kvCacheFloorGb(sizing, { ranks: 1, speculativeTokens: 3 }, paging)).toBeGreaterThan(kvCacheFloorGb(sizing, single, paging)!);
  });
});
