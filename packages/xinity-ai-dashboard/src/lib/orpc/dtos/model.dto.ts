/**
 * DTO schema for model deployments.
 */
import { z } from "zod";
import { CommonDto } from "./common.dto";

export const DeploymentDto = CommonDto.extend({
  id: z.uuid(),
  name: z.string().trim(),

  enabled: z.boolean(),
  publicSpecifier: z.string().trim(),
  /** Canonical model identifier. Required server-side at create time. */
  specifier: z.string().trim().nullish(),
  earlySpecifier: z.string().trim().nullish(),
  /** @deprecated Driver-specific provider string; derived server-side from {@link specifier}. */
  modelSpecifier: z.string().trim(),
  /** @deprecated */
  earlyModelSpecifier: z.string().trim().nullish(),
  replicas: z.number().default(1),
  canaryProgressUntil: z.date().nullish(),
  canaryProgressFrom: z.date().nullish(),
  canaryProgressWithFeedback: z.boolean().default(false),
  progress: z.number().default(100),
  kvCacheSize: z.number().nullish(),
  earlyKvCacheSize: z.number().nullish(),
  description: z.string().nullish(),
  preferredDriver: z.enum(["ollama", "vllm"]).nullish(),
});


export { type Model, ModelSchema as ModelDto } from "xinity-infoserver";
