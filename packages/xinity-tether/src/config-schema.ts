import { z } from "zod";
import {
  configNumber,
  databaseUrlField,
  defineConfig,
  defineGroup,
  env,
  expert,
  metricsGroup,
  secret,
  serverFields,
  tlsGroup,
  type MetricsConfig,
  type ServerConfig,
  type TlsConfig,
} from "common-env";
import { loggingGroup, type LoggingConfig } from "common-log";

type Server = ServerConfig & { keepaliveIntervalMs: number; livenessTimeoutMs: number };

const server = defineGroup<Server>({
  id: "server",
  title: "HTTP server",
  description: "Where the tether listens, and how it keeps daemon connections alive.",
  violations: ({ keepaliveIntervalMs, idleTimeout }) => {
    if (keepaliveIntervalMs * 3 <= idleTimeout * 1000) {
      return [];
    }
    return [{
      field: "keepaliveIntervalMs",
      message:
        `KEEPALIVE_INTERVAL_MS (${keepaliveIntervalMs}ms) must be at most a third of IDLE_TIMEOUT (${idleTimeout}s). `
        + "The server closes any connection idle for longer than IDLE_TIMEOUT, so a keepalive that slow lets it drop "
        + `live SSE connections. Set KEEPALIVE_INTERVAL_MS to ${Math.floor((idleTimeout * 1000) / 3)} or less.`,
    }];
  },
  fields: {
    ...serverFields({ host: "0.0.0.0", port: 4020 }),
    keepaliveIntervalMs: env("KEEPALIVE_INTERVAL_MS", configNumber().default(15_000)
      .describe("SSE keepalive interval in ms").meta(expert())),
    livenessTimeoutMs: env("LIVENESS_TIMEOUT_MS", configNumber().default(45_000)
      .describe("Time before a silent connection is considered dead").meta(expert())),
  },
});

type Database = { connectionUrl: string };

const db = defineGroup<Database>({
  id: "db",
  title: "Database",
  fields: { connectionUrl: databaseUrlField() },
});

export type TetherConfig = {
  server: Server;
  db: Database;
  metrics: MetricsConfig;
  log: LoggingConfig;
  tls: TlsConfig | undefined;
  /** Not in a group: it authenticates daemons, which nothing else here is about. */
  tetherSecret: string;
};

export const tetherConfig = defineConfig<TetherConfig>({
  server,
  db,
  metrics: metricsGroup(),
  log: loggingGroup(),
  tls: tlsGroup(),
  tetherSecret: env("TETHER_SECRET", z.string().min(1)
    .describe("Shared secret for daemon authentication").meta(secret())),
});
