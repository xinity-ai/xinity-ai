import { z } from "zod";
import { expert } from "common-env";

/** Zod schema fragment for logging env vars. Merge into service schemas via `.extend(logEnvSchema.shape)`. */
export const logEnvSchema = z.object({
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info")
    .describe("Log level")
    .meta(expert()),
  LOG_DIR: z.string().optional().describe("Log file directory (enables file logging)").meta(expert()),
});

export type LogEnv = z.infer<typeof logEnvSchema>;
