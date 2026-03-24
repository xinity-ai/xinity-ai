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
  modelSpecifier: z.string().trim(),
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
