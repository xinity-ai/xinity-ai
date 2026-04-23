import { z } from "zod";
import { expert } from "common-env";
import { logEnvSchema } from "common-log";

export const infoserverEnvSchema = z.object({
  MODEL_INFO_FILE: z.string().optional().describe("Deprecated: use MODEL_INFO_DIR instead. Path to a single model info YAML file. Will be removed in 1.0.0"),
  MODEL_INFO_DIR: z.string().optional().describe("Directory of model YAML files (*.yaml, *.yml) to load. This is the preferred way to configure model sources"),
  PORT: z.coerce.number().default(8090).describe("Listen port"),
  REFRESH_INTERVAL_MS: z.coerce.number().default(5 * 60_000).describe("How often to re-read model file and re-fetch includes (ms)").meta(expert()),
  MAX_INCLUDE_DEPTH: z.coerce.number().default(10).describe("Maximum recursion depth when resolving include URLs").meta(expert()),
}).extend(logEnvSchema.shape);
