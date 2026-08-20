/**
 * Configuration options for the Nemotron module.
 */
export interface NemotronConfig {
  /** Master switch. When false, all operations bypass with zero overhead. */
  enabled: boolean;
  /** Internal HTTP endpoint for Nemotron worker (e.g. http://localhost:8000/v1). */
  endpoint?: string;
  /** Optional auth token for the internal worker. */
  apiKey?: string;
  /** Model specifier for guardrail inspection. Default: 'nemotron-mini-4b'. */
  guardModel?: string;
  /** Model specifier for reward evaluation. Default: 'nemotron-3-reward'. */
  rewardModel?: string;
  /** Guardrail strictness level. */
  strictness?: "low" | "medium" | "high";
  /** Minimum composite reward score to flag for distillation dataset. Default: 0.90. */
  distillationThreshold?: number;
}

/**
 * Result of a guardrail inspection.
 */
export type GuardrailVerdict = {
  /** True if the request or response is permitted under policy. */
  allowed: boolean;
  /** Reason for rejection if allowed is false. */
  reason?: string;
  /** Category of violation (e.g. 'prompt_injection', 'jailbreak', 'pii', 'toxic'). */
  category?: string;
  /** Confidence score between 0.0 and 1.0. */
  confidence?: number;
  /** True when the remote guard was skipped (circuit open, timeout, error). */
  guardSkipped?: boolean;
  /** Reason the guard was skipped (e.g. 'circuit_open', 'timeout', 'error', 'disabled'). */
  skipReason?: string;
};

/**
 * Input for pre-flight prompt guardrail inspection.
 */
export interface PreFlightInspectionInput {
  model: string;
  messages: Array<{
    role: string;
    content: unknown;
  }>;
  organizationId?: string;
  apiKeyId?: string;
}

/**
 * Input for post-flight response guardrail inspection.
 */
export interface PostFlightInspectionInput {
  model: string;
  prompt: string;
  response: string;
  organizationId?: string;
}

/**
 * Fine-grained multi-attribute evaluation dimensions scored by Nemotron.
 */
export interface RewardAttributes {
  /** How well the answer satisfies the user's intent (0.0 to 1.0). */
  helpfulness: number;
  /** Factual soundness and adherence to instructions (0.0 to 1.0). */
  correctness: number;
  /** Logical flow and structure (0.0 to 1.0). */
  coherence: number;
  /** Depth and reasoning sophistication (0.0 to 1.0). */
  complexity: number;
  /** Compliance with safety and privacy policies (0.0 to 1.0). */
  safety: number;
}

/**
 * Result of multi-attribute reward scoring.
 */
export interface RewardScoreResult {
  /** Individual attribute scores. */
  attributes: RewardAttributes;
  /** Weighted aggregate score (0.0 to 1.0). */
  compositeScore: number;
  /** True if the interaction meets the quality threshold for distillation. */
  distillationEligible: boolean;
  /** Timestamp when evaluation was performed. */
  evaluatedAt: number;
}

/**
 * Result from the Nemotron HTTP client, distinguishing
 * successful responses from various skip/failure reasons.
 */
export type ClientResult<T> =
  | { status: "success"; data: T }
  | { status: "skipped"; reason: "disabled" | "circuit_open" | "error" | "timeout" };
