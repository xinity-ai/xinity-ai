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
  IDLE_TIMEOUT: z.coerce.number().int().min(1).max(255).default(255)
    .describe("Seconds a connection may go without traffic before the server closes it (Bun allows at most 255). Keepalive writes reset it, so daemons stay connected indefinitely")
    .meta(expert()),
  KEEPALIVE_INTERVAL_MS: z.coerce.number().default(15_000).describe("SSE keepalive interval in ms").meta(expert()),
  LIVENESS_TIMEOUT_MS: z.coerce.number().default(45_000).describe("Time before a silent connection is considered dead").meta(expert()),
}).extend(logEnvSchema.shape).check((ctx) => {
  const keepaliveMs = ctx.value.KEEPALIVE_INTERVAL_MS;
  const idleTimeoutMs = ctx.value.IDLE_TIMEOUT * 1000;
  if (keepaliveMs * 3 > idleTimeoutMs) {
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      path: ["KEEPALIVE_INTERVAL_MS"],
      message:
        `KEEPALIVE_INTERVAL_MS (${keepaliveMs}ms) must be at most a third of IDLE_TIMEOUT (${ctx.value.IDLE_TIMEOUT}s). ` +
        `The server closes any connection idle for longer than IDLE_TIMEOUT, so a keepalive that slow lets it drop live SSE connections. ` +
        `Set KEEPALIVE_INTERVAL_MS to ${Math.floor(idleTimeoutMs / 3)} or less.`,
    });
  }
});
