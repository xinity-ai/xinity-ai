/**
 * DTO schema for model deployments.
 */
import { z } from "zod";
import { CommonDto } from "./common.dto";

export const DeploymentSettingsDto = z.object({
  version: z.literal(1),
  maxAudioInputDurationS: z.number().int().min(1).max(24 * 60 * 60).optional(),
  maxAudioInputFileSizeMB: z.number().int().min(1).optional(),
});

export const DeploymentDto = CommonDto.extend({
  name: z.string().trim(),

  enabled: z.boolean(),
  publicSpecifier: z.string().trim()
    .refine(s => !s.endsWith("-deep-research"), {
      message: "Deployment names cannot end with '-deep-research' (reserved suffix)",
    }),
  /** Canonical model identifier. */
  specifier: z.string().trim(),
  /** Canonical identifier for the canary (early) model in a canary deployment. */
  earlySpecifier: z.string().trim().nullish(),
  replicas: z.number().default(1),
  canaryProgressUntil: z.date().nullish(),
  canaryProgressFrom: z.date().nullish(),
  canaryProgressWithFeedback: z.boolean().default(false),
  progress: z.number().default(100),
  kvCacheSize: z.number().nullish(),
  earlyKvCacheSize: z.number().nullish(),
  description: z.string().nullish(),
  preferredDriver: z.enum(["ollama", "vllm"]).nullish(),
  settings: DeploymentSettingsDto.optional(),
});


export { type Model, ModelSchema as ModelDto } from "xinity-infoserver";
