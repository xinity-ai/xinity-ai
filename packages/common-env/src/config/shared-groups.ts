import { z } from "zod";
import { expert, secret } from "../index";
import { metricsAuthSchema } from "../metrics-auth";
import { configInt, configNumber } from "./leaf-types";
import { defineGroup, env, type GroupDef } from "./group";

export type ServerConfig = { host: string; port: number; idleTimeout: number; unixSocket?: string };

/** HOST, PORT, UNIX_SOCKET and IDLE_TIMEOUT, written out once for the three services that bind a port. */
export function serverGroup(defaults: {
  host: string;
  port: number;
  idleTimeout?: number;
}): GroupDef<ServerConfig> {
  return defineGroup<ServerConfig>({
    id: "server",
    title: "HTTP server",
    fields: {
      host: env("HOST", z.string().default(defaults.host)
        .describe("Bind address (use 0.0.0.0 to listen on all interfaces)")),
      port: env("PORT", configNumber().default(defaults.port).describe("Listen port")),
      idleTimeout: env("IDLE_TIMEOUT", configNumber(z.number().max(255)).default(defaults.idleTimeout ?? 255)
        .describe("Seconds a connection may go without traffic before it is closed (Bun allows at most 255)")),
      unixSocket: env("UNIX_SOCKET", z.string().optional()
        .describe("Unix socket path (overrides HOST/PORT when set)").meta(expert())),
    },
  });
}

export type DatabaseConfig = { connectionUrl: string; maxConnections: number };

export function databaseGroup(defaults: { maxConnections: number }): GroupDef<DatabaseConfig> {
  return defineGroup<DatabaseConfig>({
    id: "db",
    title: "Database",
    fields: {
      connectionUrl: env("DB_CONNECTION_URL", z.url()
        .describe("PostgreSQL connection string (e.g. postgresql://user:pass@host:5432/dbname)")
        .meta(secret())),
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

// The dashboard needs a variant that requires auth. It also needs metricsAuthSchema to discriminate
// its return type on `required`, which it does not yet, so that lands when the dashboard is ported.
export function metricsGroup(): GroupDef<MetricsConfig> {
  return defineGroup<MetricsConfig>({
    id: "metrics",
    title: "Metrics endpoint",
    fields: {
      auth: env("METRICS_AUTH", metricsAuthSchema()
        .describe("Basic auth for the /metrics endpoint (format: user:pass, comma-separated for multiple)")
        .meta(secret())),
    },
  });
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
    description: "SeaweedFS or any S3-compatible endpoint for conversation media. Without it the database carries the bytes itself.",
    expert: true,
    optional: { requires: ["endpoint", "accessKeyId", "secretAccessKey"] },
    fields: {
      endpoint: env("S3_ENDPOINT", z.url().describe("SeaweedFS / S3-compatible endpoint URL")),
      accessKeyId: env("S3_ACCESS_KEY_ID", z.string().describe("S3 access key ID").meta(secret())),
      secretAccessKey: env("S3_SECRET_ACCESS_KEY", z.string().describe("S3 secret access key").meta(secret())),
      bucket: env("S3_BUCKET", z.string().default("xinity-media").describe("S3 bucket for media objects")),
      region: env("S3_REGION", z.string().default("us-east-1")
        .describe("S3 region (use 'us-east-1' for SeaweedFS)")),
    },
  });
}

export type TlsConfig = { cert: string; key: string };

export const TLS_DESCRIPTION =
  "Opt-in HTTPS. See https://github.com/xinity-ai/xinity-ai/blob/main/docs/security/tls.md";

// Exposed alongside the group so a service can spread them into a larger TLS group of its own.
export function tlsFields() {
  return {
    cert: env("XINITY_TLS_CERT", z.string().describe("PEM-encoded TLS certificate").meta(secret())),
    key: env("XINITY_TLS_KEY", z.string().describe("PEM-encoded TLS private key").meta(secret())),
  };
}

export function tlsGroup(): GroupDef<TlsConfig | undefined> {
  return defineGroup<TlsConfig>({
    id: "tls",
    title: "TLS",
    description: TLS_DESCRIPTION,
    expert: true,
    optional: { requires: ["cert", "key"] },
    fields: tlsFields(),
  });
}
