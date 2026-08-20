import { describe, expect, it } from "bun:test";
import { NemotronRewardEngine } from "./reward";

describe("NemotronRewardEngine", () => {
  it("returns null when disabled", async () => {
    const engine = new NemotronRewardEngine({ enabled: false });
    const result = await engine.evaluate("What is 2+2?", "2+2 equals 4.");
    expect(result).toBeNull();
  });

  it("returns null when enabled but no endpoint is configured (no fake scores)", async () => {
    const engine = new NemotronRewardEngine({ enabled: true });
    const result = await engine.evaluate("What is 2+2?", "2+2 equals 4.");
    expect(result).toBeNull();
  });

  it("calculates composite score accurately from attributes", () => {
    const engine = new NemotronRewardEngine({ enabled: true });
    const score = engine.computeCompositeScore({
      helpfulness: 1.0,
      correctness: 1.0,
      coherence: 1.0,
      complexity: 1.0,
      safety: 1.0,
    });
    expect(score).toBe(1.0);
  });

  it("evaluates remote reward attributes and flags distillation eligibility", async () => {
    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          attributes: {
            helpfulness: 0.95,
            correctness: 0.95,
            coherence: 0.92,
            complexity: 0.88,
            safety: 1.0,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const engine = new NemotronRewardEngine(
      { enabled: true, endpoint: "http://mock-nemotron:8000/v1", distillationThreshold: 0.9 },
      mockFetch as any,
    );

    const result = await engine.evaluate("Explain photosynthesis", "Photosynthesis is the process...");
    expect(result).not.toBeNull();
    expect(result!.compositeScore).toBeGreaterThan(0.9);
    expect(result!.distillationEligible).toBe(true);
  });

  it("returns null gracefully when remote endpoint errors", async () => {
    const mockFetch = async () => {
      return new Response("Service Unavailable", { status: 503 });
    };

    const engine = new NemotronRewardEngine(
      { enabled: true, endpoint: "http://mock-nemotron:8000/v1" },
      mockFetch as any,
    );

    const result = await engine.evaluate("Explain photosynthesis", "Photosynthesis is the process...");
    expect(result).toBeNull();
  });
});
