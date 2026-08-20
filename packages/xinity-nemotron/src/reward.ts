import type { NemotronConfig, RewardAttributes, RewardScoreResult } from "./types";
import { NemotronClient, type NemotronFetch } from "./nemotron-client";

export class NemotronRewardEngine {
  private readonly config: NemotronConfig;
  private readonly client: NemotronClient;

  constructor(config: NemotronConfig, fetchImpl?: NemotronFetch) {
    this.config = config;
    this.client = new NemotronClient(config, fetchImpl);
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Evaluates prompt and assistant response across multi-dimensional criteria.
   * Returns null if disabled or if no remote endpoint is available —
   * no fake scores are better than misleading ones.
   */
  async evaluate(prompt: string, response: string): Promise<RewardScoreResult | null> {
    if (!this.config.enabled) {
      return null;
    }

    if (!this.client.isEnabled) {
      // No endpoint configured — return null instead of fake heuristic scores.
      // A missing score is more honest than a fabricated one.
      return null;
    }

    const threshold = this.config.distillationThreshold ?? 0.9;
    const now = Date.now();

    const payload = {
      model: this.config.rewardModel ?? "nemotron-3-reward",
      prompt,
      response,
    };

    const result = await this.client.post<typeof payload, { attributes: Partial<RewardAttributes> }>(
      "/reward/score",
      payload,
    );

    if (result.status === "skipped") {
      // Remote unavailable (circuit open, timeout, error) — no score.
      return null;
    }

    if (result.data?.attributes) {
      const attributes: RewardAttributes = {
        helpfulness: result.data.attributes.helpfulness ?? 0,
        correctness: result.data.attributes.correctness ?? 0,
        coherence: result.data.attributes.coherence ?? 0,
        complexity: result.data.attributes.complexity ?? 0,
        safety: result.data.attributes.safety ?? 0,
      };

      const compositeScore = this.computeCompositeScore(attributes);
      return {
        attributes,
        compositeScore,
        distillationEligible: compositeScore >= threshold,
        evaluatedAt: now,
      };
    }

    return null;
  }

  /**
   * Computes a weighted composite score (0.0 to 1.0).
   */
  computeCompositeScore(attrs: RewardAttributes): number {
    const score =
      attrs.helpfulness * 0.3 +
      attrs.correctness * 0.35 +
      attrs.coherence * 0.15 +
      attrs.complexity * 0.1 +
      attrs.safety * 0.1;

    return Number(Math.min(1.0, Math.max(0.0, score)).toFixed(4));
  }
}

