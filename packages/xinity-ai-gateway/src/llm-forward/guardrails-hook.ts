import {
  NemotronGuardEngine,
  NemotronRewardEngine,
  type GuardrailVerdict,
  type RewardScoreResult,
} from "xinity-nemotron";
import { env } from "../env";
import { errorResponse } from "./util";
import { rootLogger } from "../logger";
import {
  recordNemotronGuardSkip,
  recordNemotronPostflight,
  recordNemotronPreflight,
  recordNemotronReward,
} from "../metrics";

const log = rootLogger.child({ name: "nemotron-hook" });

let _guardEngine: NemotronGuardEngine | null = null;
let _rewardEngine: NemotronRewardEngine | null = null;

function getGuardEngine(): NemotronGuardEngine {
  if (!_guardEngine) {
    _guardEngine = new NemotronGuardEngine({
      enabled: env.XINITY_NEMOTRON_ENABLED,
      endpoint: env.XINITY_NEMOTRON_ENDPOINT,
      apiKey: env.XINITY_NEMOTRON_API_KEY,
      guardModel: env.XINITY_NEMOTRON_GUARD_MODEL,
      strictness: env.XINITY_NEMOTRON_GUARD_STRICTNESS,
    });
  }
  return _guardEngine;
}

function getRewardEngine(): NemotronRewardEngine {
  if (!_rewardEngine) {
    _rewardEngine = new NemotronRewardEngine({
      enabled: env.XINITY_NEMOTRON_ENABLED,
      endpoint: env.XINITY_NEMOTRON_ENDPOINT,
      apiKey: env.XINITY_NEMOTRON_API_KEY,
      rewardModel: env.XINITY_NEMOTRON_REWARD_MODEL,
      distillationThreshold: env.XINITY_NEMOTRON_DISTILLATION_THRESHOLD,
    });
  }
  return _rewardEngine;
}

/**
 * Pre-flight guardrail check on incoming user messages.
 * Returns an HTTP Error Response if blocked, or null if permitted.
 */
export async function checkPreFlightGuard(
  model: string,
  rawBody: Record<string, unknown>,
): Promise<Response | null> {
  if (!env.XINITY_NEMOTRON_ENABLED) {
    return null;
  }

  const messages = rawBody.messages;
  if (!Array.isArray(messages)) {
    return null;
  }

  const startTime = Date.now();
  const engine = getGuardEngine();
  const verdict = await engine.inspectPreFlight({
    model,
    messages: messages as Array<{ role: string; content: unknown }>,
  });

  const durationMs = Date.now() - startTime;

  if (verdict.guardSkipped) {
    recordNemotronGuardSkip("pre_flight", verdict.skipReason ?? "unknown");
    log.info(
      { model, reason: verdict.skipReason },
      "Nemotron pre-flight guardrail check skipped (fail-open)",
    );
  }

  if (!verdict.allowed) {
    recordNemotronPreflight("block", verdict.category ?? "policy_violation", durationMs);
    log.warn(
      { model, category: verdict.category, reason: verdict.reason },
      "Request blocked by Nemotron pre-flight guardrail",
    );
    return errorResponse(verdict.reason ?? "Rejected by enterprise safety policy", 400);
  }

  recordNemotronPreflight("allow", "clean", durationMs);
  return null;
}

/**
 * Post-flight guardrail check on generated assistant response.
 * Returns the GuardrailVerdict.
 */
export async function checkPostFlightGuard(
  model: string,
  prompt: string,
  response: string,
): Promise<GuardrailVerdict> {
  if (!env.XINITY_NEMOTRON_ENABLED) {
    return { allowed: true };
  }

  const engine = getGuardEngine();
  const verdict = await engine.inspectPostFlight({
    model,
    prompt,
    response,
  });

  if (verdict.guardSkipped) {
    recordNemotronGuardSkip("post_flight", verdict.skipReason ?? "unknown");
    log.info(
      { model, reason: verdict.skipReason },
      "Nemotron post-flight guardrail check skipped (fail-open)",
    );
  }

  recordNemotronPostflight(
    verdict.allowed ? "allow" : "block",
    verdict.category ?? (verdict.allowed ? "clean" : "unsafe_generation"),
  );

  if (!verdict.allowed) {
    log.warn(
      { model, category: verdict.category, reason: verdict.reason },
      "Model output blocked by Nemotron post-flight guardrail",
    );
  }

  return verdict;
}

/**
 * Evaluates dialogue quality and multi-attribute reward scores post-flight.
 */
export async function recordPostFlightReward(
  prompt: string,
  response: string,
  model?: string,
): Promise<RewardScoreResult | null> {
  if (!env.XINITY_NEMOTRON_ENABLED) {
    return null;
  }

  const engine = getRewardEngine();
  try {
    const result = await engine.evaluate(prompt, response);
    if (result) {
      recordNemotronReward(result.compositeScore, result.distillationEligible, model ?? "unknown");
      log.info(
        {
          model,
          score: result.compositeScore,
          distillationEligible: result.distillationEligible,
          attributes: result.attributes,
        },
        "Nemotron reward score calculated",
      );
    }
    return result;
  } catch (err) {
    log.warn({ err, model }, "Error during Nemotron reward evaluation");
    return null;
  }
}
