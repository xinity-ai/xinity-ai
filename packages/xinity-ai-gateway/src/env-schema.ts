import { z } from "zod";
import { secret, expert, tlsEnvSchema, metricsAuthSchema } from "common-env";
import { logEnvSchema } from "common-log";
import { WEB_SEARCH_PROVIDER_NAMES } from "./llm-forward/tools/search-providers";

export const gatewayEnvSchema = z.object({
  HOST: z.string().default("localhost").describe("Bind address (use 0.0.0.0 to listen on all interfaces)"),
  PORT: z.coerce.number().default(4010).describe("Listen port"),
  IDLE_TIMEOUT: z.coerce.number().max(255).default(255).describe("Timeout in seconds after which the request is assumed to be stalled and interrupted (max 255)"),
  UNIX_SOCKET: z.string().optional().describe("Unix socket path (overrides HOST/PORT when set)").meta(expert()),
  DB_CONNECTION_URL: z.url().describe("PostgreSQL connection string (e.g. postgresql://user:pass@host:5432/dbname)").meta(secret()),
  REDIS_URL: z.url().describe("Redis connection URL (e.g. redis://localhost:6379)").meta(secret()),
  INFOSERVER_URL: z.url().default("https://sysinfo.xinity.ai").describe("Infoserver URL (default hosted: https://sysinfo.xinity.ai, or your self-hosted instance)"),
  WEB_SEARCH_PROVIDER: z.enum(WEB_SEARCH_PROVIDER_NAMES).optional()
    .describe("Web search backend. When unset, web search is disabled.")
    .meta(expert()),
  WEB_SEARCH_CREDENTIAL: z.string().optional()
    .describe("Provider credential: searxng=instance URL, google=apikey:cx, bing/brave/serper/tavily=API key")
    .meta({ ...secret(), ...expert() }),
  WEB_SEARCH_ENGINE_URL: z.url().optional()
    .describe("@deprecated Use WEB_SEARCH_PROVIDER + WEB_SEARCH_CREDENTIAL instead. SearXNG search engine URL.")
    .meta(expert()),
  RESPONSE_CACHE_TTL_SECONDS: z.coerce
    .number()
    .positive()
    .default(3600)
    .describe("Response cache TTL in seconds")
    .meta(expert()),
  METRICS_AUTH: metricsAuthSchema().describe("Basic auth for the /metrics endpoint (format: user:pass, comma-separated for multiple)").meta(secret()),
  INFOSERVER_CACHE_TTL_MS: z.coerce.number().default(10 * 60_000).describe("How long the local catalog snapshot is trusted before a conditional re-fetch (ms). A refresh costs one 304 when nothing changed, so the ceiling on how stale a new entry can be is what this trades against").meta(expert()),
  LOAD_BALANCE_STRATEGY: z.enum(["random", "round-robin", "least-connections"])
    .default("least-connections")
    .describe("Load balancing strategy for distributing requests across inference nodes")
    .meta(expert()),
  BACKEND_TIMEOUT_MS: z.coerce.number().positive().default(300_000)
    .describe("Backend timeout in ms (default: 5 min). For streaming requests this is an idle timeout that resets on each chunk; for non-streaming requests it is a wall-clock deadline.")
    .meta(expert()),
  S3_ENDPOINT: z.url().optional().describe("SeaweedFS / S3-compatible endpoint URL (enables multimodal image storage)").meta(expert()),
  S3_ACCESS_KEY_ID: z.string().optional().describe("S3 access key ID").meta({ ...secret(), ...expert() }),
  S3_SECRET_ACCESS_KEY: z.string().optional().describe("S3 secret access key").meta({ ...secret(), ...expert() }),
  S3_BUCKET: z.string().default("xinity-media").describe("S3 bucket for media objects").meta(expert()),
  S3_REGION: z.string().default("us-east-1").describe("S3 region (use 'us-east-1' for SeaweedFS)").meta(expert()),
  // Inference backend TLS
  XINITY_INFERENCE_CA: z.string().optional()
    .describe("PEM-encoded CA certificate for verifying daemon TLS. When set, gateway connects to daemons via HTTPS. See https://github.com/xinity-ai/xinity-ai/blob/main/docs/security/tls.md")
    .meta({ ...secret(), ...expert() }),
  DEEP_RESEARCH_MAX_STEPS: z.coerce.number().positive().default(30)
    .describe("Maximum tool-call steps for deep research mode")
    .meta(expert()),
  DEEP_RESEARCH_COMPACTION_THRESHOLD: z.coerce.number().min(0.1).max(0.95).default(0.70)
    .describe("Fraction of model context window at which compaction triggers")
    .meta(expert()),
}).extend(tlsEnvSchema.shape).extend(logEnvSchema.shape);
