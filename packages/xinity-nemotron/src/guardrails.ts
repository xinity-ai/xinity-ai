import type {
  GuardrailVerdict,
  NemotronConfig,
  PostFlightInspectionInput,
  PreFlightInspectionInput,
} from "./types";
import { NemotronClient, type NemotronFetch } from "./nemotron-client";

/**
 * Normalizes text to defeat common obfuscation techniques:
 * - NFKD unicode normalization (collapses fullwidth, compatibility chars)
 * - Strips zero-width characters (ZWJ, ZWNJ, ZW-Space, etc.)
 * - Collapses whitespace
 */
function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    // Strip combining diacritical marks (e.g. accents) so patterns match accent-insensitively
    .replace(/[\u0300-\u036f]/g, "")
    // Remove zero-width characters: U+200B (ZW Space), U+200C (ZWNJ), U+200D (ZWJ),
    // U+200E/F (direction marks), U+FEFF (BOM/ZWNBS), U+2060 (Word Joiner)
    .replace(/[\u200B-\u200F\uFEFF\u2060]/g, "")
    // Collapse multiple whitespace into single space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Known adversarial jailbreak patterns.
 * All patterns are matched against diacritic-stripped, NFKD-normalized text.
 */
const KNOWN_JAILBREAK_PATTERNS = [
  // English patterns
  /\bignore all previous instructions\b/i,
  /\bdisregard (all |any )?(prior|previous) (rules|instructions|guidelines)\b/i,
  /\byou are now in developer mode\b/i,
  /\bDAN mode activated\b/i,
  /\bact as (?:an? )?(?:unrestricted|unfiltered|uncensored)\b/i,
  /\bpretend (?:that )?(?:you have no|there are no) (?:rules|restrictions|guidelines)\b/i,
  /\byou (?:must|should|will) (?:obey|follow|comply with) (?:only )?my instructions\b/i,
  /\bjailbreak\b/i,
  /\bsystem prompt[:;]\s*.{0,20}(?:reveal|show|print|output|display)/i,
  // German patterns
  /\bignoriere alle (?:vorherigen |bisherigen )?(?:Anweisungen|Regeln|Richtlinien)\b/i,
  /\bmissachte (?:alle )?(?:vorherigen |bisherigen )?(?:Anweisungen|Regeln)\b/i,
  /\bdu bist jetzt im (?:Entwickler|Developer)[- ]?modus\b/i,
  // French patterns
  /\bignore(?:z)? toutes les instructions precedentes\b/i,
  // Spanish patterns
  /\bignora todas las instrucciones (?:previas|anteriores)\b/i,
];

export class NemotronGuardEngine {
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
   * Pre-flight inspection of user prompts before passing to primary LLM.
   */
  async inspectPreFlight(input: PreFlightInspectionInput): Promise<GuardrailVerdict> {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    const rawText = this.extractMessageText(input.messages);
    const textContent = normalizeText(rawText);

    // Fast static heuristics pass
    for (const pattern of KNOWN_JAILBREAK_PATTERNS) {
      if (pattern.test(textContent)) {
        return {
          allowed: false,
          category: "prompt_injection",
          reason: "Prompt rejected by enterprise safety policy: adversarial jailbreak pattern detected",
          confidence: 0.98,
        };
      }
    }

    // Dynamic model verification pass if endpoint configured
    if (this.client.isEnabled) {
      const payload = {
        model: this.config.guardModel ?? "nemotron-mini-4b",
        prompt: textContent,
        check: "pre_flight",
        strictness: this.config.strictness ?? "medium",
      };

      const result = await this.client.post<typeof payload, { safe: boolean; category?: string; reason?: string }>(
        "/guardrails/inspect",
        payload,
      );

      if (result.status === "skipped") {
        // Fail-open: allow the request but mark the verdict so callers can log/alert
        return {
          allowed: true,
          guardSkipped: true,
          skipReason: result.reason,
        };
      }

      if (!result.data.safe) {
        return {
          allowed: false,
          category: result.data.category ?? "policy_violation",
          reason: result.data.reason ?? "Prompt rejected by enterprise safety policy",
          confidence: 0.95,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Post-flight verification of generated output.
   */
  async inspectPostFlight(input: PostFlightInspectionInput): Promise<GuardrailVerdict> {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    if (this.client.isEnabled) {
      const payload = {
        model: this.config.guardModel ?? "nemotron-mini-4b",
        prompt: input.prompt,
        response: input.response,
        check: "post_flight",
        strictness: this.config.strictness ?? "medium",
      };

      const result = await this.client.post<typeof payload, { safe: boolean; category?: string; reason?: string }>(
        "/guardrails/inspect",
        payload,
      );

      if (result.status === "skipped") {
        return {
          allowed: true,
          guardSkipped: true,
          skipReason: result.reason,
        };
      }

      if (!result.data.safe) {
        return {
          allowed: false,
          category: result.data.category ?? "unsafe_generation",
          reason: result.data.reason ?? "Model output failed safety verification",
          confidence: 0.95,
        };
      }
    }

    return { allowed: true };
  }

  private extractMessageText(messages: PreFlightInspectionInput["messages"]): string {
    const parts: string[] = [];
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        parts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item && typeof item === "object" && "text" in item && typeof (item as { text: unknown }).text === "string") {
            parts.push((item as { text: string }).text);
          }
        }
      }
    }
    return parts.join("\n");
  }
}
