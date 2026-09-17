import { z } from "zod";
import {
  catalogGroup,
  configInt,
  configNumber,
  databaseGroup,
  defineConfig,
  defineGroup,
  dynamic,
  env,
  expert,
  metricsGroup,
  objectStorageGroup,
  previousSecretKeyField,
  secret,
  secretKeyField,
  serverGroup,
  tlsGroup,
  type CatalogConfig,
  type DatabaseConfig,
  type MetricsConfig,
  type ObjectStorageConfig,
  type ServerConfig,
  type TlsConfig,
} from "common-env";
import { loggingGroup, type LoggingConfig } from "common-log";
import { WEB_SEARCH_PROVIDER_NAMES, webSearchPairSchema } from "./llm-forward/tools/search-providers";

type Cache = {
  url: string;
  responseTtlSeconds: () => number;
  applicationTtlSeconds: () => number;
  apiKeyTtlSeconds: () => number;
  authFailureTtlSeconds: () => number;
  modelTtlSeconds: () => number;
  digestEntries: () => number;
};

const ttl = (seconds: number) => configNumber(z.number().positive()).default(seconds).meta(expert());

const cache = defineGroup<Cache>({
  id: "cache",
  title: "Cache",
  description: "Redis, and the lifetimes of what the gateway keeps in it.",
  fields: {
    url: env("REDIS_URL", z.url({ protocol: /^(redis|valkey)s?$/ })
      .describe("Redis or Valkey connection URL (e.g. redis://:PASSWORD@localhost:6379). Percent-encode the password.").meta(secret())),
    responseTtlSeconds: dynamic("RESPONSE_CACHE_TTL_SECONDS", ttl(3600)
      .describe("How long an identical completion is served from cache instead of the backend")),
    applicationTtlSeconds: dynamic("CACHE_APPLICATION_TTL_SECONDS", ttl(300)
      .describe("How long an application name to id lookup is cached")),
    apiKeyTtlSeconds: dynamic("CACHE_API_KEY_TTL_SECONDS", ttl(120)
      .describe("How long a validated API key is cached, so every request does not hit the database")),
    authFailureTtlSeconds: dynamic("CACHE_AUTH_FAILURE_TTL_SECONDS", ttl(10)
      .describe("How long a rejected API key is remembered. Short, so re-enabling a key takes effect promptly")),
    modelTtlSeconds: dynamic("CACHE_MODEL_TTL_SECONDS", ttl(60)
      .describe("How long a model deployment lookup is cached")),
    digestEntries: dynamic("CACHE_DIGEST_MAX_ENTRIES", configInt(z.int().positive()).default(5_000)
      .describe("Entries held in the in-process chat message digest cache, which avoids re-hashing repeated history")
      .meta(expert())),
  },
});

type WebSearch = {
  provider: () => (typeof WEB_SEARCH_PROVIDER_NAMES)[number] | undefined;
  credential: () => string | undefined;
  engineUrl?: string;
};

const webSearch = defineGroup<WebSearch>({
  id: "webSearch",
  title: "Web search",
  description: "Backend for web-search-augmented generation. Disabled when unset.",
  expert: true,
  violations: ({ provider, credential }) => {
    if (!provider) {
      return [];
    }
    const pair = webSearchPairSchema.safeParse({ provider, credential });
    return pair.success ? [] : [{ field: "credential", message: pair.error.issues[0]!.message }];
  },
  fields: {
    provider: dynamic("WEB_SEARCH_PROVIDER", z.enum(WEB_SEARCH_PROVIDER_NAMES).optional()
      .describe("Web search backend. When unset, web search is disabled.")),
    credential: dynamic("WEB_SEARCH_CREDENTIAL", z.string().optional()
      .describe("Provider credential: searxng=instance URL, google=apikey:cx, bing/brave/serper/tavily=API key")
      .meta(secret())),
    engineUrl: env("WEB_SEARCH_ENGINE_URL", z.url().optional()
      .describe("@deprecated Use WEB_SEARCH_PROVIDER + WEB_SEARCH_CREDENTIAL instead. SearXNG search engine URL.")),
  },
});

type Inference = {
  loadBalanceStrategy: () => "random" | "round-robin" | "least-connections";
  backendTimeoutMs: () => number;
  /** Verifying daemon certificates is independent of serving HTTPS, so it does not live in `tls`. */
  ca?: string;
};

const inference = defineGroup<Inference>({
  id: "inference",
  title: "Inference backends",
  description: "How the gateway picks a node, how long it waits, and how it trusts one.",
  expert: true,
  fields: {
    loadBalanceStrategy: dynamic("LOAD_BALANCE_STRATEGY",
      z.enum(["random", "round-robin", "least-connections"]).default("least-connections")
        .describe("Load balancing strategy for distributing requests across inference nodes")),
    backendTimeoutMs: dynamic("BACKEND_TIMEOUT_MS", configNumber(z.number().positive()).default(300_000)
      .describe("Backend timeout in ms (default: 5 min). For streaming requests this is an idle timeout that resets on each chunk; for non-streaming requests it is a wall-clock deadline.")),
    ca: env("XINITY_INFERENCE_CA", z.string().optional()
      .describe("PEM-encoded CA certificate for verifying daemon TLS. When set, gateway connects to daemons via HTTPS.")
      .meta(secret())),
  },
});

type DeepResearch = { maxSteps: number; compactionThreshold: number };

const deepResearch = defineGroup<DeepResearch>({
  id: "deepResearch",
  title: "Deep research",
  expert: true,
  fields: {
    maxSteps: env("DEEP_RESEARCH_MAX_STEPS", configNumber(z.number().positive()).default(30)
      .describe("Maximum tool-call steps for deep research mode")),
    compactionThreshold: env("DEEP_RESEARCH_COMPACTION_THRESHOLD",
      configNumber(z.number().min(0.1).max(0.95)).default(0.70)
        .describe("Fraction of model context window at which compaction triggers")),
  },
});

export type GatewayConfig = {
  server: ServerConfig;
  db: DatabaseConfig;
  cache: Cache;
  infoserver: CatalogConfig;
  metrics: MetricsConfig;
  log: LoggingConfig;
  s3: ObjectStorageConfig | undefined;
  tls: TlsConfig | undefined;
  webSearch: WebSearch;
  inference: Inference;
  deepResearch: DeepResearch;
  secretKey?: string;
  previousSecretKey?: string;
};

export const gatewayConfig = defineConfig<GatewayConfig>({
  server: serverGroup({ host: "0.0.0.0", port: 4010 }),
  db: databaseGroup({ maxConnections: 20 }),
  cache,
  infoserver: catalogGroup(),
  metrics: metricsGroup(),
  log: loggingGroup(),
  s3: objectStorageGroup(),
  tls: tlsGroup(),
  webSearch,
  inference,
  deepResearch,
  secretKey: secretKeyField(),
  previousSecretKey: previousSecretKeyField(),
});
