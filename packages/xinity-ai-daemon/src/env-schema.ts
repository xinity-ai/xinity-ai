import { z } from "zod";
import { secret, expert, tlsEnvSchema } from "common-env";
import { logEnvSchema } from "common-log";

export const daemonEnvSchema = z.object({
  PORT: z.coerce.number().default(4044).describe("Listen port"),
  HOST: z.string().default("0.0.0.0").describe("Bind address (use 0.0.0.0 to listen on all interfaces)"),
  UNIX_SOCKET: z.string().optional().describe("Unix socket path (overrides HOST/PORT)").meta(expert()),
  IDLE_TIMEOUT: z.coerce.number().default(255).describe("Timeout in seconds after which idle connections are closed").meta(expert()),
  XINITY_OLLAMA_ENDPOINT: z.url().optional().describe("Ollama API endpoint, typically http://localhost:11434 (enables ollama driver)"),
  DB_CONNECTION_URL: z.url().describe("PostgreSQL connection string (e.g. postgresql://user:pass@host:5432/dbname)").meta(secret()),
  INFOSERVER_URL: z.url().default("https://sysinfo.xinity.ai").describe("Infoserver URL (default hosted: https://sysinfo.xinity.ai, or your self-hosted instance)"),
  STATE_DIR: z.string().default("./.local").describe("Local state directory for daemon runtime data").meta(expert()),
  CIDR_PREFIX: z.string().default("").describe("Network CIDR prefix (e.g. '192.168') to filter which local IP the daemon advertises. Empty = first non-internal IPv4 address"),
  SYNC_INTERVAL_MS: z.coerce
    .number()
    .default(1000 * 60 * 5)
    .describe("Sync interval in milliseconds")
    .meta(expert()),
  INFOSERVER_CACHE_TTL_MS: z.coerce.number().default(30_000).describe("How long to cache infoserver responses locally (ms)").meta(expert()),

  // vLLM configuration
  VLLM_BACKEND: z.enum(["systemd", "docker"]).default("systemd").describe("vLLM backend type"),
  VLLM_ENV_DIR: z.string().default("/etc/vllm").describe("vLLM environment config directory").meta(expert()),
  VLLM_TEMPLATE_UNIT_PATH: z
    .string()
    .default("/etc/systemd/system/vllm-driver@.service")
    .describe("vLLM systemd template unit path")
    .meta(expert()),
  VLLM_PATH: z.string().optional().describe("Path to vllm binary (enables vllm-systemd driver). Install: https://docs.vllm.ai/en/latest/getting_started/installation/index.html"),
  VLLM_DOCKER_IMAGE: z
    .string()
    .optional()
    .describe(
      "vLLM Docker image (enables vllm-docker driver). " +
      "Options: vllm/vllm-openai (https://hub.docker.com/r/vllm/vllm-openai), " +
      "nvcr.io/nvidia/vllm (https://catalog.ngc.nvidia.com/orgs/nvidia/containers/vllm), " +
      "nvcr.io/nvidia/igx-dgx/vllm (for DGX Spark devices)",
    ),
  VLLM_HF_CACHE_DIR: z.string().default("/var/lib/vllm/hf-cache").describe("HuggingFace cache directory").meta(expert()),
  VLLM_TRITON_CACHE_DIR: z.string().default("/var/lib/vllm/triton-cache").describe("Triton cache directory").meta(expert()),
  VLLM_HF_TOKEN: z.string().optional().describe("HuggingFace token for downloading private or gated models").meta({ ...secret(), ...expert() }),
  VLLM_HEALTH_TIMEOUT_MS: z.coerce
    .number()
    .default(60 * 60 * 1000)
    .describe("vLLM health check timeout in milliseconds (default: 1 hour)")
    .meta(expert()),
  VLLM_HEALTH_POLL_INTERVAL_MS: z.coerce
    .number()
    .default(5_000)
    .describe("vLLM health check poll interval in milliseconds")
    .meta(expert()),
  VLLM_MAX_RESTART_COUNT: z.coerce
    .number()
    .default(3)
    .describe("Max container restarts before marking installation as permanently failed")
    .meta(expert()),

  // mTLS
  XINITY_TLS_CLIENT_CA: z.string().optional()
    .describe("PEM-encoded CA certificate for mTLS client verification. See docs/security/mtls.md")
    .meta(secret()),
}).extend(tlsEnvSchema.shape).extend(logEnvSchema.shape);
