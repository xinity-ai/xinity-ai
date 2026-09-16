import { z } from "zod";
import { expert, secret } from "../index";
import { metricsAuthSchema } from "../metrics-auth";
import { configInt, configList, configNumber } from "./leaf-types";
import { defineGroup, env, type ConfigField, type GroupDef } from "./group";

export type ServerConfig = { host: string; port: number; idleTimeout: number; unixSocket?: string };

export function serverFields(defaults: { host: string; port: number; idleTimeout?: number }) {
  return {
    host: env("HOST", z.string().default(defaults.host)
      .describe("Bind address (use 0.0.0.0 to listen on all interfaces)")),
    port: env("PORT", configNumber().default(defaults.port).describe("Listen port")),
    idleTimeout: env("IDLE_TIMEOUT", configNumber(z.number().max(255)).default(defaults.idleTimeout ?? 255)
      .describe("Seconds a connection may go without traffic before it is closed (Bun allows at most 255)")),
    unixSocket: env("UNIX_SOCKET", z.string().optional()
      .describe("Unix socket path (overrides HOST/PORT when set)").meta(expert())),
  };
}

export function serverGroup(defaults: { host: string; port: number; idleTimeout?: number }): GroupDef<ServerConfig> {
  return defineGroup<ServerConfig>({ id: "server", title: "HTTP server", fields: serverFields(defaults) });
}

export type DatabaseConfig = { connectionUrl: string; maxConnections: number };

export function databaseUrlField() {
  return env("DB_CONNECTION_URL", z.url()
    .describe("PostgreSQL connection string (e.g. postgresql://user:pass@host:5432/dbname)")
    .meta(secret()));
}

export function databaseGroup(defaults: { maxConnections: number }): GroupDef<DatabaseConfig> {
  return defineGroup<DatabaseConfig>({
    id: "db",
    title: "Database",
    fields: {
      connectionUrl: databaseUrlField(),
      maxConnections: env("DB_MAX_CONNECTIONS", configInt(z.int().positive()).default(defaults.maxConnections)
        .describe("Maximum PostgreSQL connection pool size").meta(expert())),
    },
  });
}

export type CatalogConfig = { url: string; cacheTtlMs: number };

export function catalogGroup(): GroupDef<CatalogConfig> {
  return defineGroup<CatalogConfig>({
    id: "infoserver",
    title: "Model catalog",
    fields: {
      url: env("INFOSERVER_URL", z.url().default("https://sysinfo.xinity.ai")
        .describe("Infoserver URL (default hosted: https://sysinfo.xinity.ai, or your self-hosted instance)")),
      cacheTtlMs: env("INFOSERVER_CACHE_TTL_MS", configNumber().default(10 * 60_000)
        .describe("How long the local catalog snapshot is trusted before a conditional re-fetch (ms). A refresh costs one 304 when nothing changed, so the ceiling on how stale a new entry can be is what this trades against")
        .meta(expert())),
    },
  });
}

export type MetricsConfig = { auth?: string };

const METRICS_AUTH_DESCRIPTION =
  "Basic auth for the /metrics endpoint (format: user:pass, comma-separated for multiple)";

export function metricsAuthField(opts: { required: true }): ConfigField<string>;
export function metricsAuthField(opts?: { required?: false }): ConfigField<string | undefined>;
export function metricsAuthField(opts: { required?: boolean } = {}) {
  return opts.required
    ? env("METRICS_AUTH", metricsAuthSchema({ required: true })
      .describe(METRICS_AUTH_DESCRIPTION).meta(secret()))
    : env("METRICS_AUTH", metricsAuthSchema()
      .describe(METRICS_AUTH_DESCRIPTION).meta(secret()));
}

const METRICS_GROUP = { id: "metrics", title: "Metrics endpoint" } as const;

export function metricsGroup(opts: { required: true }): GroupDef<Required<MetricsConfig>>;
export function metricsGroup(opts?: { required?: false }): GroupDef<MetricsConfig>;
export function metricsGroup(opts: { required?: boolean } = {}) {
  return opts.required
    ? defineGroup<Required<MetricsConfig>>({
      ...METRICS_GROUP,
      fields: { auth: metricsAuthField({ required: true }) },
    })
    : defineGroup<MetricsConfig>({ ...METRICS_GROUP, fields: { auth: metricsAuthField() } });
}

export function tetherSecretField() {
  return env("TETHER_SECRET", z.string().min(1)
    .describe("Shared secret authenticating daemons to the tether")
    .meta(secret()));
}

export function secretKeyField() {
  return env("XINITY_SECRET_KEY", z.string().optional()
    .describe("32 bytes of base64 (openssl rand -base64 32) encrypting dashboard-managed secrets at rest. The same value on every host that sets or reads one")
    .meta(secret()));
}

export function previousSecretKeyField() {
  return env("XINITY_SECRET_KEY_PREVIOUS", z.string().optional()
    .describe("The key XINITY_SECRET_KEY replaced, accepted for decryption only. Set during a rotation, removed once every value has been re-sealed")
    .meta({ ...secret(), ...expert() }));
}

export type ObjectStorageConfig = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
};

export function objectStorageGroup(): GroupDef<ObjectStorageConfig | undefined> {
  return defineGroup<ObjectStorageConfig>({
    id: "s3",
    title: "Object storage",
    description: "Any S3-compatible endpoint for conversation media. Without it the database carries the bytes itself.",
    expert: true,
    optional: { requires: ["endpoint", "accessKeyId", "secretAccessKey"] },
    fields: {
      endpoint: env("S3_ENDPOINT", z.url().describe("S3-compatible endpoint URL")),
      accessKeyId: env("S3_ACCESS_KEY_ID", z.string().describe("S3 access key ID").meta(secret())),
      secretAccessKey: env("S3_SECRET_ACCESS_KEY", z.string().describe("S3 secret access key").meta(secret())),
      bucket: env("S3_BUCKET", z.string().default("xinity-media").describe("S3 bucket for media objects")),
      region: env("S3_REGION", z.string().default("us-east-1")
        .describe("S3 region. Endpoints that are not AWS usually ignore it, and 'us-east-1' is the conventional value")),
    },
  });
}

export type TlsConfig = { cert: string; key: string };

export function tlsGroup(): GroupDef<TlsConfig | undefined> {
  return defineGroup<TlsConfig>({
    id: "tls",
    title: "TLS",
    description: "Opt-in HTTPS. See https://github.com/xinity-ai/xinity-ai/blob/main/docs/security/tls.md",
    expert: true,
    optional: { requires: ["cert", "key"] },
    fields: {
      cert: env("XINITY_TLS_CERT", z.string().describe("PEM-encoded TLS certificate").meta(secret())),
      key: env("XINITY_TLS_KEY", z.string().describe("PEM-encoded TLS private key").meta(secret())),
    },
  });
}

export type ProxyConfig = { header?: string; xffDepth: number };
export type TrustingProxyConfig = ProxyConfig & { trustedProxies: string[] };

const proxyFields = () => ({
  header: env("HTTP_IP_HEADER", z.string().optional()
    .describe("Header the client IP is forwarded in (e.g. x-forwarded-for). Without it, requests all appear to come from the proxy")),
  xffDepth: env("HTTP_XFF_DEPTH", configInt(z.int().min(1)).default(1)
    .describe("Number of proxies in front. Anything further left in the header is client-supplied and forgeable")),
});

const PROXY_GROUP = {
  id: "proxy",
  title: "Reverse proxy",
  description: "Only needed when something sits in front of this service.",
  expert: true,
} as const;

const trustedProxy = z.union([z.cidrv4(), z.cidrv6(), z.ipv4(), z.ipv6()]);

export function proxyGroup(opts: { trustedProxies: true }): GroupDef<TrustingProxyConfig>;
export function proxyGroup(opts?: { trustedProxies?: false }): GroupDef<ProxyConfig>;
export function proxyGroup(opts: { trustedProxies?: boolean } = {}) {
  if (!opts.trustedProxies) {
    return defineGroup<ProxyConfig>({ ...PROXY_GROUP, fields: proxyFields() });
  }
  return defineGroup<TrustingProxyConfig>({
    ...PROXY_GROUP,
    fields: {
      ...proxyFields(),
      trustedProxies: env("HTTP_TRUSTED_PROXIES", configList(trustedProxy).default([])
        .describe("Restricts the forwarding header to these addresses or CIDR ranges (e.g. 10.0.0.0/8). Empty accepts it from any source, which is what a proxy-only route needs")),
    },
  });
}
