import { z } from "zod";
import { secret, expert, metricsAuthSchema } from "common-env";
import { logEnvSchema } from "common-log";

export const tetherEnvSchema = z.object({
  HOST: z.string().default("0.0.0.0").describe("Bind address"),
  PORT: z.coerce.number().default(4020).describe("Listen port"),
  UNIX_SOCKET: z.string().optional().describe("Unix socket path (overrides HOST/PORT)").meta(expert()),
  DB_CONNECTION_URL: z.url().describe("PostgreSQL connection string").meta(secret()),
  TETHER_SECRET: z.string().min(1).describe("Shared secret for daemon authentication").meta(secret()),
  METRICS_AUTH: metricsAuthSchema().describe("Metrics basic auth, comma-separated user:pass pairs").meta(secret()),
  KEEPALIVE_INTERVAL_MS: z.coerce.number().default(15_000).describe("SSE keepalive interval in ms").meta(expert()),
  LIVENESS_TIMEOUT_MS: z.coerce.number().default(45_000).describe("Time before a silent connection is considered dead").meta(expert()),
}).extend(logEnvSchema.shape);
