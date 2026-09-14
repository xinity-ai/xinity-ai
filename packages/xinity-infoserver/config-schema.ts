import { z } from "zod";
import {
  configBool,
  configInt,
  configNumber,
  defineConfig,
  defineGroup,
  env,
  expert,
  proxyGroup,
  type ProxyConfig,
} from "common-env";
import { loggingGroup, type LoggingConfig } from "common-log";

type Server = { port: number };

const server = defineGroup<Server>({
  id: "server",
  title: "HTTP server",
  fields: {
    port: env("PORT", configNumber().default(8090).describe("Listen port")),
  },
});

type Catalog = {
  infoDir: string;
  legacyDir?: string;
  refreshIntervalMs: number;
  maxIncludeDepth: number;
};

const catalog = defineGroup<Catalog>({
  id: "catalog",
  title: "Model catalog",
  description: "Where model files are read from, and how often they are re-read.",
  fields: {
    infoDir: env("MODEL_INFO_DIR", z.string()
      .describe("Directory of model YAML files (*.yaml, *.yml) in the current format")),
    legacyDir: env("MODEL_LEGACY_DIR", z.string().optional()
      .describe("Directory of model YAML files in the deprecated v1 format, served only on the v1 endpoints. Removed before 1.0.0, so migrate these entries to MODEL_INFO_DIR. Leave unset to serve the v1 endpoints as an empty catalog")),
    refreshIntervalMs: env("REFRESH_INTERVAL_MS", configNumber().default(5 * 60_000)
      .describe("How often to re-read model files and re-fetch includes (ms)").meta(expert())),
    maxIncludeDepth: env("MAX_INCLUDE_DEPTH", configNumber().default(10)
      .describe("Maximum recursion depth when resolving include URLs").meta(expert())),
  },
});

type RateLimit = { enabled: boolean; exportPerMinute: number; apiPerMinute: number };

const rateLimit = defineGroup<RateLimit>({
  id: "rateLimit",
  title: "Rate limiting",
  expert: true,
  fields: {
    enabled: env("RATE_LIMIT_ENABLED", configBool().default(true)
      .describe("Apply per-client request ceilings. Disable only on a trusted network")),
    exportPerMinute: env("RATE_LIMIT_EXPORT_PER_MINUTE", configInt(z.int().min(1)).default(60)
      .describe("Full-catalog requests allowed per client per minute, spendable all at once. Every client fetches the whole catalog once per refresh, and processes behind one address share a bucket, so this has to clear several of them at once rather than just one")),
    apiPerMinute: env("RATE_LIMIT_API_PER_MINUTE", configInt(z.int().min(1)).default(600)
      .describe("Programmatic API requests allowed per client per minute, spendable all at once")),
  },
});

export type InfoserverConfig = {
  server: Server;
  catalog: Catalog;
  rateLimit: RateLimit;
  proxy: ProxyConfig;
  log: LoggingConfig;
};

export const infoserverConfig = defineConfig<InfoserverConfig>({
  server,
  catalog,
  rateLimit,
  proxy: proxyGroup(),
  log: loggingGroup(),
});
