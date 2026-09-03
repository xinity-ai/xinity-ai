import { z } from "zod";
import {
  catalogGroup,
  configInt,
  configNumber,
  defineConfig,
  defineGroup,
  env,
  expert,
  metricsAuthField,
  secret,
  serverFields,
  tlsGroup,
  type CatalogConfig,
  type ServerConfig,
  type TlsConfig,
} from "common-env";
import { loggingGroup, type LoggingConfig } from "common-log";

type Tether = { url: string; secret: string; syncIntervalMs: number };

const tether = defineGroup<Tether>({
  id: "tether",
  title: "Tether",
  description: "The control plane this node reports to.",
  fields: {
    url: env("TETHER_URL", z.url().describe("URL of the xinity-tether service (e.g. http://tether:4020)")),
    secret: env("TETHER_SECRET", z.string().min(1)
      .describe("Shared secret for tether authentication").meta(secret())),
    syncIntervalMs: env("SYNC_INTERVAL_MS", configNumber().default(1000 * 60 * 5)
      .describe("Sync interval in milliseconds").meta(expert())),
  },
});

type Node = { machineName?: string; cidrPrefix: string; stateDir: string };

const node = defineGroup<Node>({
  id: "node",
  title: "This node",
  fields: {
    machineName: env("MACHINE_NAME", z.string().optional()
      .describe("Display name for this node (defaults to hostname)").meta(expert())),
    cidrPrefix: env("CIDR_PREFIX", z.string().default("")
      .describe("Network CIDR prefix (e.g. '192.168') to filter which local IP the daemon advertises. Empty = first non-internal IPv4 address")),
    stateDir: env("STATE_DIR", z.string().default("./.local")
      .describe("Local state directory for daemon runtime data").meta(expert())),
  },
});

type Metrics = { auth?: string; sampleIntervalMs: number };

const metrics = defineGroup<Metrics>({
  id: "metrics",
  title: "Metrics endpoint",
  fields: {
    auth: metricsAuthField(),
    sampleIntervalMs: env("METRICS_SAMPLE_INTERVAL_MS", configNumber().default(20_000)
      .describe("GPU telemetry sampling interval in milliseconds").meta(expert())),
  },
});

type Vllm = {
  backend: "systemd" | "docker";
  envDir: string;
  templateUnitPath: string;
  path?: string;
  dockerImage?: string;
  hfCacheDir: string;
  tritonCacheDir: string;
  hfToken?: string;
  healthTimeoutMs: number;
  healthPollIntervalMs: number;
  maxRestartCount: number;
};

const vllm = defineGroup<Vllm>({
  id: "vllm",
  title: "vLLM",
  description: "How this node runs vLLM models.",
  fields: {
    backend: env("VLLM_BACKEND", z.enum(["systemd", "docker"]).default("systemd")
      .describe("vLLM backend type")),
    envDir: env("VLLM_ENV_DIR", z.string().default("/etc/vllm")
      .describe("vLLM environment config directory").meta(expert())),
    templateUnitPath: env("VLLM_TEMPLATE_UNIT_PATH", z.string().default("/etc/systemd/system/vllm-driver@.service")
      .describe("vLLM systemd template unit path").meta(expert())),
    path: env("VLLM_PATH", z.string().optional()
      .describe("Path to the vllm binary. With VLLM_BACKEND=systemd it is executed directly; with VLLM_BACKEND=docker it is the entrypoint used inside the image (default: vllm on the image PATH). Install: https://docs.vllm.ai/en/latest/getting_started/installation/index.html")),
    dockerImage: env("VLLM_DOCKER_IMAGE", z.string().optional()
      .describe(
        "vLLM Docker image (enables vllm-docker driver). "
        + "Options: vllm/vllm-openai (https://hub.docker.com/r/vllm/vllm-openai), "
        + "timothystewart6/vllm-gb10 (https://hub.docker.com/r/timothystewart6/vllm-gb10, for DGX Spark / GB10 devices), "
        + "vllm/vllm-openai:cu130-nightly (for DGX Spark / Blackwell devices)",
      )),
    hfCacheDir: env("VLLM_HF_CACHE_DIR", z.string().default("/var/lib/vllm/hf-cache")
      .describe("HuggingFace cache directory").meta(expert())),
    tritonCacheDir: env("VLLM_TRITON_CACHE_DIR", z.string().default("/var/lib/vllm/triton-cache")
      .describe("Triton cache directory").meta(expert())),
    hfToken: env("VLLM_HF_TOKEN", z.string().optional()
      .describe("HuggingFace token for downloading private or gated models").meta(secret())),
    healthTimeoutMs: env("VLLM_HEALTH_TIMEOUT_MS", configNumber().default(60 * 60 * 1000)
      .describe("vLLM health check timeout in milliseconds (default: 1 hour)").meta(expert())),
    healthPollIntervalMs: env("VLLM_HEALTH_POLL_INTERVAL_MS", configNumber().default(5_000)
      .describe("vLLM health check poll interval in milliseconds").meta(expert())),
    maxRestartCount: env("VLLM_MAX_RESTART_COUNT", configInt(z.int().positive()).default(3)
      .describe("Max container restarts before marking installation as permanently failed").meta(expert())),
  },
});

export type DaemonConfig = {
  server: ServerConfig;
  tether: Tether;
  node: Node;
  infoserver: CatalogConfig;
  metrics: Metrics;
  vllm: Vllm;
  tls: TlsConfig | undefined;
  log: LoggingConfig;
  /** Its own driver, with one knob, so it is not worth a group of its own. */
  ollamaUrl: string;
};

export const daemonConfig = defineConfig<DaemonConfig>({
  server: defineGroup<ServerConfig>({
    id: "server",
    title: "HTTP server",
    fields: serverFields({ host: "0.0.0.0", port: 4044 }),
  }),
  tether,
  node,
  infoserver: catalogGroup(),
  metrics,
  vllm,
  tls: tlsGroup(),
  log: loggingGroup(),
  ollamaUrl: env("OLLAMA_URL", z.url().default("http://localhost:11434")
    .describe("Ollama API endpoint. The ollama driver is enabled whenever this endpoint answers, so it only needs setting when ollama does not listen on its default local port")
    .meta(expert())),
});
