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
  env,
  expert,
  metricsAuthField,
  objectStorageGroup,
  proxyGroup,
  secret,
  type CatalogConfig,
  type DatabaseConfig,
  type ObjectStorageConfig,
  type ProxyConfig,
} from "common-env";
import { loggingGroup, type LoggingConfig } from "common-log";

type Server = { port: number; origin: string; trustedOrigins: string[] };

const server = defineGroup<Server>({
  id: "server",
  title: "HTTP server",
  description: "The port it listens on, and the URL browsers reach it at.",
  fields: {
    port: env("HTTP_PORT", configInt().default(5173)
      .describe("TCP port the server listens on (use a reverse proxy if deploying behind HTTPS)")
      .meta(expert())),
    origin: env("ORIGIN", z.url().default("http://localhost:5173")
      .describe("Public origin URL, no trailing slash (e.g. https://xinity.mydomain.com)")),
    trustedOrigins: env("TRUSTED_ORIGINS", configList(z.string()).default([])
      .describe("Additional trusted origins for CSRF validation behind reverse proxies")
      .meta(expert())),
  },
});

type Auth = {
  secret: string;
  signupEnabled: boolean;
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
    signupEnabled: env("SIGNUP_ENABLED", configBool().default(true)
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
  deploymentStrategy: "first-fit" | "balanced" | "bin-pack" | "proportional";
  prometheusUrl?: string;
};

const compute = defineGroup<Compute>({
  id: "compute",
  title: "Compute",
  description: "Model deployment across inference nodes, and what the Compute page shows.",
  expert: true,
  fields: {
    managementEnabled: env("COMPUTE_MANAGEMENT_ENABLED", configBool().default(true)
      .describe("Enable compute management")),
    deploymentStrategy: env("DEPLOYMENT_STRATEGY",
      z.enum(["first-fit", "balanced", "bin-pack", "proportional"]).default("balanced")
        .describe("Node selection strategy for new model installations. 'first-fit' picks the first node that fits (deterministic). 'balanced' picks the node with the most absolute free VRAM (spread for HA). 'bin-pack' picks the tightest fit (consolidate so idle nodes stay drainable). 'proportional' picks the node with the lowest percent utilization (fair spread across heterogeneous nodes).")),
    prometheusUrl: env("PROMETHEUS_URL", z.url().optional()
      .describe("Prometheus server URL for live GPU metrics overlay on the Compute page (e.g. http://prometheus:9090). Enables utilization rings and energy readouts on compute nodes.")),
  },
});

type Audit = { url: string; auth?: string; tenant?: string };

const audit = defineGroup<Audit>({
  id: "audit",
  title: "Audit event export",
  description: "Mirrors audit events to Loki for SIEM ingestion. Requires a license with the audit-log feature.",
  expert: true,
  optional: { requires: ["url"] },
  fields: {
    url: env("AUDIT_LOKI_URL", z.url()
      .describe("Loki base URL to mirror audit events to (e.g. http://localhost:6122)")),
    auth: env("AUDIT_LOKI_AUTH", z.string().optional()
      .describe("Basic auth for AUDIT_LOKI_URL as user:pass. Only needed when the Loki endpoint is authenticated.")
      .meta(secret())),
    tenant: env("AUDIT_LOKI_TENANT", z.string().optional()
      .describe("Tenant id sent as X-Scope-OrgID. Only needed for multi-tenant Loki or Grafana Cloud.")),
  },
});

type Metrics = { auth: string };

const metrics = defineGroup<Metrics>({
  id: "metrics",
  title: "Metrics endpoint",
  fields: {
    auth: metricsAuthField({ required: true }),
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
  metrics: Metrics;
  s3: ObjectStorageConfig | undefined;
  proxy: ProxyConfig;
  log: LoggingConfig;
  nodeEnv: "production" | "development" | "test";
  appName: string;
  gatewayUrl: string;
  licenseKey?: string;
  mcpEnabled: boolean;
  notificationsEnabled: boolean;
};

export const dashboardConfig = defineConfig<DashboardConfig>({
  server,
  db: databaseGroup({ maxConnections: 10 }),
  auth,
  mail,
  infoserver: catalogGroup(),
  compute,
  audit,
  metrics,
  s3: objectStorageGroup(),
  proxy: proxyGroup(),
  log: loggingGroup(),
  nodeEnv: env("NODE_ENV", z.enum(["production", "development", "test"])
    .describe("Node environment").meta(expert())),
  appName: env("APP_NAME", z.string().default("Xinity Admin")
    .describe("Application display name").meta(expert())),
  gatewayUrl: env("GATEWAY_URL", z.url().overwrite((url) => url.replace(/\/$/, "")).default("http://localhost:4010")
    .describe("Gateway base URL shown to users in docs and code examples (e.g. https://api.example.com). Must NOT include the /v1 path segment - that is appended where needed. A trailing slash is stripped.")
    .meta(clientPublic())),
  licenseKey: env("LICENSE_KEY", z.string().optional()
    .describe("License key for unlocking paid features (Ed25519-signed token)").meta(secret())),
  mcpEnabled: env("MCP_ENABLED", configBool().default(true)
    .describe("Enable the /mcp Model Context Protocol endpoint")),
  notificationsEnabled: env("NOTIFICATIONS_ENABLED", configBool().default(true)
    .describe("Enable the notification scheduler (deployment status, node health, capacity warnings, weekly reports)")
    .meta(expert())),
}, {
  violations: (config, at) => config.audit && !config.licenseKey
    ? [{
      fields: [at.audit.url, at.licenseKey],
      message: "Audit export is a licensed feature, so without a license nothing would be forwarded.",
    }]
    : [],
});
