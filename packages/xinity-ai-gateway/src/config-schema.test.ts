// Migration check, not a test of the declaration: it compares the hand-written port against the
// schema it replaces. Delete it with the hand-written env-schema.ts.
import { expect, test } from "bun:test";
import { parseEnv, toFlatSchema } from "common-env";
import { gatewayEnvSchema } from "./env-schema";
import { gatewayConfig } from "./config-schema";

const projected = toFlatSchema(gatewayConfig);

const MINIMAL = {
  DB_CONNECTION_URL: "postgresql://localhost:5432/xinity",
  REDIS_URL: "redis://localhost:6379",
};

const EVERYTHING = {
  ...MINIMAL,
  HOST: "0.0.0.0",
  PORT: "8080",
  IDLE_TIMEOUT: "120",
  UNIX_SOCKET: "/run/gateway.sock",
  DB_MAX_CONNECTIONS: "50",
  INFOSERVER_URL: "https://sysinfo.example",
  INFOSERVER_CACHE_TTL_MS: "60000",
  METRICS_AUTH: "admin:hunter2,prom:scrape",
  LOG_LEVEL: "info",
  LOG_DIR: "/var/log/xinity",
  RESPONSE_CACHE_TTL_SECONDS: "600",
  CACHE_APPLICATION_TTL_SECONDS: "60",
  CACHE_API_KEY_TTL_SECONDS: "30",
  CACHE_AUTH_FAILURE_TTL_SECONDS: "5",
  CACHE_MODEL_TTL_SECONDS: "15",
  CACHE_DIGEST_MAX_ENTRIES: "100",
  S3_ENDPOINT: "http://seaweedfs:8333",
  S3_ACCESS_KEY_ID: "AKIA",
  S3_SECRET_ACCESS_KEY: "shhh",
  S3_BUCKET: "media",
  S3_REGION: "eu-central-1",
  XINITY_TLS_CERT: "PEM-CERT",
  XINITY_TLS_KEY: "PEM-KEY",
  XINITY_INFERENCE_CA: "PEM-CA",
  WEB_SEARCH_PROVIDER: "searxng",
  WEB_SEARCH_CREDENTIAL: "http://searx:8080",
  WEB_SEARCH_ENGINE_URL: "http://searx:8080",
  LOAD_BALANCE_STRATEGY: "round-robin",
  BACKEND_TIMEOUT_MS: "60000",
  DEEP_RESEARCH_MAX_STEPS: "12",
  DEEP_RESEARCH_COMPACTION_THRESHOLD: "0.5",
};

test("the port reads exactly the keys the live schema reads", () => {
  expect(gatewayConfig.entries.map((entry) => entry.envKey).sort())
    .toEqual(Object.keys(gatewayEnvSchema.shape).sort());
});

test("and parses them identically, bare and fully populated", () => {
  expect(parseEnv(projected, MINIMAL)).toEqual(parseEnv(gatewayEnvSchema, MINIMAL));
  expect(parseEnv(projected, EVERYTHING)).toEqual(parseEnv(gatewayEnvSchema, EVERYTHING));
});
