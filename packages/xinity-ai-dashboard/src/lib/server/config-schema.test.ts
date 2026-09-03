// Migration check, not a test of the declaration. Delete it with the hand-written env-schema.ts.
import { expect, test } from "bun:test";
import { parseEnv, toFlatSchema } from "common-env";
import { dashboardEnvSchema } from "./env-schema";
import { dashboardConfig } from "./config-schema";

const projected = toFlatSchema(dashboardConfig);

/** The declaration parses these into lists, so their values are meant to differ from the flat schema. */
function comparable(parsed: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...parsed };
  delete rest.TRUSTED_ORIGINS;
  delete rest.INSTANCE_ADMIN_EMAILS;
  return rest;
}

const MINIMAL = {
  DB_CONNECTION_URL: "postgresql://localhost/test",
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "s3cret",
  METRICS_AUTH: "admin:hunter2",
};

const EVERYTHING = {
  ...MINIMAL,
  DB_MAX_CONNECTIONS: "25",
  ORIGIN: "https://xinity.example",
  HTTP_PORT: "8080",
  TRUSTED_ORIGINS: "https://alt.example",
  SIGNUP_ENABLED: "false",
  MULTI_TENANT_MODE: "true",
  INSTANCE_ADMIN_EMAILS: "Ops@Example.com",
  MAIL_URL: "smtp://user:pass@mail.example.com:587",
  MAIL_FROM: "noreply@example.com",
  INFOSERVER_URL: "https://sysinfo.example",
  INFOSERVER_CACHE_TTL_MS: "60000",
  COMPUTE_MANAGEMENT_ENABLED: "false",
  DEPLOYMENT_STRATEGY: "bin-pack",
  PROMETHEUS_URL: "http://prometheus:9090",
  AUDIT_LOKI_URL: "http://loki:3100",
  AUDIT_LOKI_AUTH: "loki:pass",
  AUDIT_LOKI_TENANT: "tenant-1",
  S3_ENDPOINT: "http://seaweed:8333",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  S3_BUCKET: "media",
  S3_REGION: "eu-central-1",
  HTTP_IP_HEADER: "x-forwarded-for",
  HTTP_XFF_DEPTH: "2",
  LOG_LEVEL: "info",
  LOG_DIR: "/var/log/xinity",
  APP_NAME: "Ops Console",
  GATEWAY_URL: "https://api.example.com",
  LICENSE_KEY: "lic_xxx",
  MCP_ENABLED: "false",
  NOTIFICATIONS_ENABLED: "false",
};

test("reads exactly the keys the live schema reads", () => {
  expect(dashboardConfig.entries.map((entry) => entry.envKey).sort())
    .toEqual(Object.keys(dashboardEnvSchema.shape).sort());
});

test("and parses them identically, bare and fully populated", () => {
  expect(comparable(parseEnv(projected, MINIMAL)))
    .toEqual(comparable(parseEnv(dashboardEnvSchema, MINIMAL)));
  expect(comparable(parseEnv(projected, EVERYTHING)))
    .toEqual(comparable(parseEnv(dashboardEnvSchema, EVERYTHING)));
});

test("the two list keys split, trim and lowercase where the flat schema kept a raw string", () => {
  const parsed = parseEnv(projected, EVERYTHING);
  expect(parsed.INSTANCE_ADMIN_EMAILS).toEqual(["ops@example.com"]);
  expect(parseEnv(projected, MINIMAL).TRUSTED_ORIGINS).toEqual([]);
});
