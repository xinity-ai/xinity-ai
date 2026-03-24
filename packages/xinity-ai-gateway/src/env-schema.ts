import { z } from "zod";
import { secret, expert } from "common-env";
import { logEnvSchema } from "common-log";

export const gatewayEnvSchema = z.object({
  HOST: z.string().default("localhost").describe("Bind address"),
  PORT: z.coerce.number().default(4010).describe("Listen port"),
  DB_CONNECTION_URL: z.url().describe("PostgreSQL connection string").meta(secret()),
  REDIS_URL: z.url().describe("Redis connection URL").meta(secret()),
  INFOSERVER_URL: z.url().describe("Infoserver URL"),
  WEB_SEARCH_ENGINE_URL: z.url().optional().describe("SearXNG search engine URL").meta(expert()),
  RESPONSE_CACHE_TTL_SECONDS: z.coerce
    .number()
    .positive()
    .default(3600)
    .describe("Response cache TTL in seconds")
    .meta(expert()),
  METRICS_AUTH: z.string().optional().describe("Metrics basic auth (comma-separated user:pass pairs)").meta({ ...secret(), ...expert() }),
  INFOSERVER_CACHE_TTL_MS: z.coerce.number().default(30_000).describe("How long to cache infoserver responses locally (ms)").meta(expert()),
  LOAD_BALANCE_STRATEGY: z.enum(["random", "round-robin", "least-connections"])
    .default("least-connections")
    .describe("Load balancing strategy for distributing requests across inference nodes")
    .meta(expert()),
  BACKEND_TIMEOUT_MS: z.coerce.number().positive().default(300_000)
    .describe("Maximum time in ms to wait for a backend response (default: 5 minutes)")
    .meta(expert()),
  S3_ENDPOINT: z.url().optional().describe("SeaweedFS / S3-compatible endpoint URL (enables multimodal image storage)").meta(expert()),
  S3_ACCESS_KEY_ID: z.string().optional().describe("S3 access key ID").meta(secret()).meta(expert()),
  S3_SECRET_ACCESS_KEY: z.string().optional().describe("S3 secret access key").meta(secret()).meta(expert()),
  S3_BUCKET: z.string().default("xinity-media").describe("S3 bucket for media objects").meta(expert()),
  S3_REGION: z.string().default("us-east-1").describe("S3 region (use 'us-east-1' for SeaweedFS)").meta(expert()),
}).extend(logEnvSchema.shape);
