import { z } from "zod";
import {
  catalogGroup,
  clientPublic,
  configBool,
  configInt,
  configList,
  databaseGroup,
  defineConfig,
  defineGroup,
  dynamic,
  env,
  expert,
  metricsGroup,
  objectStorageGroup,
  previousSecretKeyField,
  proxyGroup,
  secret,
  secretKeyField,
  tlsGroup,
  type CatalogConfig,
  type DatabaseConfig,
  type MetricsConfig,
  type ObjectStorageConfig,
  type TrustingProxyConfig,
  type TlsConfig,
} from "common-env";
import { loggingGroup, type LoggingConfig } from "common-log";

type Server = {
  host: string;
  port: number;
  idleTimeout: number;
  unixSocket?: string;
};

const server = defineGroup<Server>({
  id: "server",
  title: "HTTP server",
  description: "Where it listens.",
  fields: {
    host: env("HOST", z.string().default("0.0.0.0")
      .describe("Bind address (use 0.0.0.0 to listen on all interfaces)")),
    port: env("HTTP_PORT", configInt().default(4030)
      .describe("TCP port the server listens on")
      .meta(expert())),
    idleTimeout: env("IDLE_TIMEOUT", configInt(z.int().positive().max(255)).default(30)
      .describe("Seconds a connection may go without traffic before it is closed (Bun allows at most 255)")
      .meta(expert())),
    unixSocket: env("UNIX_SOCKET", z.string().optional()
      .describe("Unix socket path (overrides HOST and HTTP_PORT when set)").meta(expert())),
  },
});

type Auth = {
  secret: string;
  signupEnabled: () => boolean;
  multiTenantMode: boolean;
  instanceAdmins: string[];
};

const auth = defineGroup<Auth>({
  id: "auth",
  title: "Authentication",
  description: "Who can sign in, and who is allowed to create an organization.",
  violations: ({ multiTenantMode, instanceAdmins }) => {
    if (multiTenantMode || instanceAdmins.length > 0) {
      return [];
    }
    return [{
      field: "multiTenantMode",
      message:
        "With MULTI_TENANT_MODE off and INSTANCE_ADMIN_EMAILS unset, nobody can create an organization "
        + "and the instance is unusable once signed in. Set INSTANCE_ADMIN_EMAILS to the operator's "
        + "address, or turn MULTI_TENANT_MODE on to let any authenticated user create one.",
    }];
  },
  fields: {
    secret: env("BETTER_AUTH_SECRET", z.string()
      .describe("Better Auth secret key, generate with: openssl rand -base64 32").meta(secret())),
    signupEnabled: dynamic("SIGNUP_ENABLED", configBool().default(true)
      .describe("Enable user signup")),
    multiTenantMode: env("MULTI_TENANT_MODE", configBool().default(false)
      .describe("Allow any authenticated user to create organizations")),
    instanceAdmins: env("INSTANCE_ADMIN_EMAILS", configList(z.email().toLowerCase()).default([])
      .describe("Emails of users who get instance-wide admin privileges (can manage all orgs)")),
  },
});

type Mail = { url: string; from: string };

const mail = defineGroup<Mail>({
  id: "mail",
  title: "Outbound mail",
  description: "Used for invitations, password resets and notifications. Disabled when unset.",
  optional: { requires: ["url"] },
  fields: {
    url: env("MAIL_URL", z.url()
      .describe("SMTP mail server URL (e.g. smtp://user:pass@mail.example.com:587)").meta(secret())),
    from: env("MAIL_FROM", z.string()
      .describe("Email sender address (e.g. noreply@mydomain.com)")),
  },
});

type Compute = {
  managementEnabled: boolean;
  deploymentStrategy: () => "first-fit" | "balanced" | "bin-pack" | "proportional";
  prometheusUrl: () => string | undefined;
};

const compute = defineGroup<Compute>({
  id: "compute",
  title: "Compute",
  description: "Model deployment across inference nodes, and what the Compute page shows.",
  expert: true,
  fields: {
    managementEnabled: env("COMPUTE_MANAGEMENT_ENABLED", configBool().default(true)
      .describe("Enable compute management")),
    deploymentStrategy: dynamic("DEPLOYMENT_STRATEGY",
      z.enum(["first-fit", "balanced", "bin-pack", "proportional"]).default("balanced")
        .describe("Node selection strategy for new model installations. 'first-fit' picks the first node that fits (deterministic). 'balanced' picks the node with the most absolute free VRAM (spread for HA). 'bin-pack' picks the tightest fit (consolidate so idle nodes stay drainable). 'proportional' picks the node with the lowest percent utilization (fair spread across heterogeneous nodes).")),
    prometheusUrl: dynamic("PROMETHEUS_URL", z.url().optional()
      .describe("Prometheus server URL for live GPU metrics overlay on the Compute page (e.g. http://prometheus:9090). Enables utilization rings and energy readouts on compute nodes.")),
  },
});

/** RFC 5424 facility names in numeric order, so the index is the facility code. */
export const SYSLOG_FACILITIES = [
  "kern", "user", "mail", "daemon", "auth", "syslog", "lpr", "news",
  "uucp", "cron", "authpriv", "ftp", "ntp", "audit", "alert", "clock",
  "local0", "local1", "local2", "local3", "local4", "local5", "local6", "local7",
] as const;

export type Audit = {
  url: string;
  auth?: string;
  tenant?: string;
  facility: (typeof SYSLOG_FACILITIES)[number];
  framing: "octet-counting" | "lf";
  appName: string;
  ca?: string;
};

export function isLokiUrl(url: string): boolean {
  return /^https?:$/.test(new URL(url).protocol);
}

const audit = defineGroup<Audit>({
  id: "audit",
  title: "Audit event export",
  description: "Mirrors audit events to one SIEM sink. The URL scheme picks the transport: http(s) pushes to Loki, udp, tcp or tls sends RFC 5424 syslog. Settings for the other transport are ignored. Requires a license with the audit-log feature.",
  expert: true,
  optional: { requires: ["url"] },
  fields: {
    url: env("AUDIT_SINK_URL", z.url({ protocol: /^(https?|udp|tcp|tls)$/ })
      .describe("Sink audit events are mirrored to. http(s):// is a Loki base URL (e.g. http://localhost:6122), udp://, tcp:// or tls:// is a syslog collector (e.g. tls://collector.example.com:6514)")),
    auth: env("AUDIT_SINK_AUTH", z.string().optional()
      .describe("Loki only. Basic auth as user:pass, for an authenticated Loki endpoint.")
      .meta(secret())),
    tenant: env("AUDIT_SINK_TENANT", z.string().optional()
      .describe("Loki only. Tenant id sent as X-Scope-OrgID, for multi-tenant Loki or Grafana Cloud.")),
    facility: env("AUDIT_SINK_SYSLOG_FACILITY", z.enum(SYSLOG_FACILITIES).default("local0")
      .describe("Syslog only. Facility the messages are sent under, which is what collectors route on. 'audit' is the RFC 5424 log-audit facility, local0 to local7 are the site-specific ones.")),
    framing: env("AUDIT_SINK_SYSLOG_FRAMING", z.enum(["octet-counting", "lf"]).default("octet-counting")
      .describe("Syslog only. How messages are delimited on tcp and tls. 'octet-counting' is RFC 6587, which rsyslog and syslog-ng expect. 'lf' is newline-delimited, for collectors that only accept that. Ignored on udp.")),
    appName: env("AUDIT_SINK_SYSLOG_APP_NAME", z.string().default("xinity-audit")
      .describe("Syslog only. APP-NAME field of the messages. Give each instance its own name when several feed one collector.")),
    ca: env("AUDIT_SINK_SYSLOG_CA", z.string().optional()
      .describe("Syslog only. PEM certificate authority the tls:// collector is verified against. Only needed when the collector uses a private CA.")),
  },
});

export type DashboardConfig = {
  server: Server;
  db: DatabaseConfig;
  auth: Auth;
  mail: Mail | undefined;
  infoserver: CatalogConfig;
  compute: Compute;
  audit: Audit | undefined;
  metrics: Required<MetricsConfig>;
  s3: ObjectStorageConfig | undefined;
  tls: TlsConfig | undefined;
  proxy: TrustingProxyConfig;
  log: LoggingConfig;
  nodeEnv: "production" | "development" | "test";
  appName: string;
  origin: string;
  trustedOrigins: string[];
  gatewayUrl: string;
  licenseKey: () => string | undefined;
  mcpEnabled: () => boolean;
  notificationsEnabled: () => boolean;
  secretKey?: string;
  previousSecretKey?: string;
};

export const dashboardConfig = defineConfig<DashboardConfig>({
  server,
  db: databaseGroup({ maxConnections: 10 }),
  auth,
  mail,
  infoserver: catalogGroup(),
  compute,
  audit,
  metrics: metricsGroup({ required: true }),
  s3: objectStorageGroup(),
  tls: tlsGroup(),
  proxy: proxyGroup({ trustedProxies: true }),
  log: loggingGroup(),
  nodeEnv: env("NODE_ENV", z.enum(["production", "development", "test"])
    .describe("Node environment").meta(expert())),
  appName: env("APP_NAME", z.string().default("Xinity Admin")
    .describe("Application display name").meta(expert())),
  origin: env("ORIGIN", z.url().default("http://localhost:4030")
    .describe("Public origin URL browsers reach this dashboard at, no trailing slash (e.g. https://xinity.mydomain.com). The default only suits local development")),
  trustedOrigins: env("TRUSTED_ORIGINS", configList(z.string()).default([])
    .describe("Additional trusted origins for CSRF validation behind reverse proxies")
    .meta(expert())),
  gatewayUrl: env("GATEWAY_URL", z.url().overwrite((url) => url.replace(/\/$/, "")).default("http://localhost:4010")
    .describe("Gateway base URL shown to users in docs and code examples (e.g. https://api.example.com). Must NOT include the /v1 path segment - that is appended where needed. A trailing slash is stripped.")
    .meta(clientPublic())),
  licenseKey: dynamic("LICENSE_KEY", z.string().optional()
    .describe("License key for unlocking paid features (Ed25519-signed token)").meta(secret())),
  mcpEnabled: dynamic("MCP_ENABLED", configBool().default(true)
    .describe("Enable the /mcp Model Context Protocol endpoint")),
  notificationsEnabled: dynamic("NOTIFICATIONS_ENABLED", configBool().default(true)
    .describe("Enable the notification scheduler (deployment status, node health, capacity warnings, weekly reports)")
    .meta(expert())),
  secretKey: secretKeyField(),
  previousSecretKey: previousSecretKeyField(),
}, {
  violations: (config, at) => config.audit && !config.licenseKey
    ? [{
      fields: [at.audit.url, at.licenseKey],
      message: "Audit export is a licensed feature, so without a license nothing would be forwarded.",
    }]
    : [],
});
