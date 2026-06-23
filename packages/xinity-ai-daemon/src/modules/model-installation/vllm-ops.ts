import { $ } from "bun";
import { env } from "../../env";
// @ts-ignore
import templateUnit from "../../assets/vllm-driver@.service" with { type: "text" };
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "vllm-ops" });

export interface VllmInstanceConfig {
  model: string;
  port: number;
  kvCacheBytes: string;
  trustRemoteCode?: boolean;
  extraArgs?: string[];
  gpuMemoryUtilization?: number;
}

export interface VllmOps {
  /** Returns instance IDs of running vLLM instances */
  listRunning(): Promise<string[]>;
  /** Deploy and start a vLLM instance with the given config */
  start(id: string, config: VllmInstanceConfig): Promise<void>;
  /** Stop and remove a vLLM instance */
  stop(id: string): Promise<void>;
  /** Check if the vLLM health endpoint responds on the given port */
  checkHealth(port: number): Promise<boolean>;
  /** Check if the instance is still alive (running, not exited/dead) */
  isAlive(id: string): Promise<boolean>;
  /** Retrieve recent logs (stdout/stderr) for an instance. Returns empty string on failure. */
  getLogs(id: string, tailLines?: number): Promise<string>;
  /** Get the number of times the instance has restarted since creation */
  getRestartCount(id: string): Promise<number>;
  /** One-time setup (install systemd template / ensure docker image availability) */
  ensureSetup(): Promise<void>;
}

async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function parseRestartCount(raw: string): number {
  const count = parseInt(raw.trim(), 10);
  return Number.isNaN(count) ? 0 : count;
}

function nonEmptyLines(raw: string): string[] {
  return raw.split("\n").map((line) => line.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Systemd implementation
// ---------------------------------------------------------------------------

export function buildSystemdEnvFile(config: VllmInstanceConfig): string {
  const lines = [
    `VLLM_MODEL=${config.model}`,
    `VLLM_PORT=${config.port}`,
    `VLLM_HOST=127.0.0.1`,
    `VLLM_SERVED_MODEL_NAME=${config.model}`,
    `VLLM_KV_CACHE_BYTES=${config.kvCacheBytes}`,
  ];
  if (env.VLLM_PATH) {
    lines.push(`VLLM_BINARY_PATH=${env.VLLM_PATH}`);
  }
  if (config.trustRemoteCode) {
    lines.push(`VLLM_TRUST_REMOTE_CODE=true`);
  }
  if (config.gpuMemoryUtilization != null) {
    lines.push(`VLLM_GPU_MEMORY_UTILIZATION=${config.gpuMemoryUtilization}`);
  }
  if (config.extraArgs && config.extraArgs.length > 0) {
    lines.push(`VLLM_EXTRA_ARGS=${config.extraArgs.join(" ")}`);
  }
  if (env.VLLM_HF_TOKEN) {
    lines.push(`HF_TOKEN=${env.VLLM_HF_TOKEN}`);
  }
  return lines.join("\n") + "\n";
}

/** Append CLI flags that are identical between the systemd and docker vLLM commands. */
function appendVllmCommonArgs(args: string[], config: VllmInstanceConfig): void {
  if (config.gpuMemoryUtilization != null) {
    args.push("--gpu-memory-utilization", String(config.gpuMemoryUtilization));
  }
  if (config.trustRemoteCode) {
    args.push("--trust-remote-code");
  }
  if (config.extraArgs && config.extraArgs.length > 0) {
    args.push(...config.extraArgs);
  }
}

// Mirror of the ExecStart logic in src/assets/vllm-driver@.service; keep in sync.
export function buildSystemdServeArgv(config: VllmInstanceConfig): string[] {
  const binary = env.VLLM_PATH || "/usr/bin/vllm";
  const argv = [binary, "serve", config.model,
    "--host", "127.0.0.1",
    "--port", String(config.port),
  ];
  if (config.kvCacheBytes) {
    argv.push("--kv-cache-memory-bytes", config.kvCacheBytes);
  }
  argv.push("--served-model-name", config.model);
  appendVllmCommonArgs(argv, config);
  return argv;
}

const SYSTEMD_UNIT_INSTANCE_RE = /^vllm-driver@(.+)\.service$/;
const systemdUnitFor = (id: string) => `vllm-driver@${id}.service`;

export function createSystemdVllmOps(): VllmOps {
  return {
    async listRunning() {
      const result =
        await $`systemctl list-units 'vllm-driver@*' --type=service --state=active --no-legend --plain`
          .nothrow()
          .text();

      return nonEmptyLines(result)
        .map((line) => {
          const unit = line.split(/\s+/)[0] ?? "";
          const match = unit.match(SYSTEMD_UNIT_INSTANCE_RE);
          return match?.[1];
        })
        .filter((id): id is string => id != null);
    },

    async start(id, config) {
      await $`mkdir -p ${env.VLLM_ENV_DIR}`;
      const envPath = `${env.VLLM_ENV_DIR}/${id}.env`;
      const envContent = buildSystemdEnvFile(config);
      log.info(
        { id, envPath, config },
        "Starting vLLM systemd service",
      );
      await Bun.write(envPath, envContent);
      await $`chmod 644 ${envPath}`;
      await $`systemctl enable --now ${systemdUnitFor(id)}`;
    },

    async stop(id) {
      await $`systemctl disable --now ${systemdUnitFor(id)}`.nothrow();
      await $`rm -f ${env.VLLM_ENV_DIR}/${id}.env`;
    },

    checkHealth,

    async isAlive(id) {
      const result = await $`systemctl is-active ${systemdUnitFor(id)}`
        .nothrow()
        .text();
      return result.trim() === "active";
    },

    async getLogs(id, tailLines = 200) {
      try {
        const result = await $`journalctl -u ${systemdUnitFor(id)} --no-pager -n ${tailLines} --output=short-iso`
          .nothrow()
          .text();
        return result.trim();
      } catch {
        return "";
      }
    },

    async getRestartCount(id) {
      const result = await $`systemctl show -p NRestarts --value ${systemdUnitFor(id)}`
        .nothrow()
        .text();
      return parseRestartCount(result);
    },

    async ensureSetup() {
      const targetPath = env.VLLM_TEMPLATE_UNIT_PATH;
      const existing = await Bun.file(targetPath).text().catch(() => null);
      if (existing != null) {
        log.debug({ targetPath }, "vLLM systemd template already present, skipping");
      } else {
        await Bun.write(targetPath, templateUnit);
        await $`systemctl daemon-reload`;
        log.info("Installed vLLM systemd template unit");
      }

      // Ensure cache and env directories exist with correct ownership.
      // The vllm-driver@ template runs as User=vllm with
      // ReadWritePaths=/var/lib/vllm, so these must be pre-created.
      await $`mkdir -p ${env.VLLM_HF_CACHE_DIR} ${env.VLLM_TRITON_CACHE_DIR} ${env.VLLM_ENV_DIR}`;
      await $`chown -R vllm:vllm ${env.VLLM_HF_CACHE_DIR} ${env.VLLM_TRITON_CACHE_DIR}`.nothrow();
    },
  };
}

// ---------------------------------------------------------------------------
// Docker implementation
// ---------------------------------------------------------------------------

const DOCKER_CONTAINER_PREFIX = "vllm-";
const dockerContainerNameFor = (id: string) => `${DOCKER_CONTAINER_PREFIX}${id}`;

/** "daemon" runs detached with a restart policy; "preview" runs interactive with --rm. */
export function buildDockerRunArgs(
  id: string,
  config: VllmInstanceConfig,
  mode: "daemon" | "preview" = "daemon",
): string[] {
  const dockerImage = env.VLLM_DOCKER_IMAGE;
  if (!dockerImage) {
    throw new Error("VLLM_DOCKER_IMAGE must be set to build a docker run command");
  }
  const containerName = dockerContainerNameFor(id);
  const lifecycleFlags = mode === "daemon" ? ["-d"] : ["-it", "--rm"];
  const args = [
    "docker", "run", ...lifecycleFlags,
    "--name", containerName,
    "--gpus", "all",
    "--ipc=host",
    "-p", `127.0.0.1:${config.port}:8000`,
    "-e", "HF_HOME=/data/hf-cache",
    "-e", "TRITON_CACHE_DIR=/data/triton-cache",
    "-v", `${env.VLLM_HF_CACHE_DIR}:/data/hf-cache`,
    "-v", `${env.VLLM_TRITON_CACHE_DIR}:/data/triton-cache`,
    ...(mode === "daemon" ? ["--restart", "unless-stopped"] : []),
    dockerImage,
    "--model", config.model,
    "--served-model-name", config.model,
    "--kv-cache-memory-bytes", config.kvCacheBytes,
  ];
  appendVllmCommonArgs(args, config);
  return args;
}

export function createDockerVllmOps(): VllmOps {
  return {
    async listRunning() {
      const result =
        await $`docker ps --filter name=${DOCKER_CONTAINER_PREFIX} --format '{{.Names}}'`
          .text();

      return nonEmptyLines(result)
        .filter((name) => name.startsWith(DOCKER_CONTAINER_PREFIX))
        .map((name) => name.slice(DOCKER_CONTAINER_PREFIX.length));
    },

    async start(id, config) {
      const containerName = dockerContainerNameFor(id);
      // Remove any existing stopped/exited container with this name
      await $`docker rm -f ${containerName}`.nothrow();

      const args = buildDockerRunArgs(id, config);

      log.info(
        { id, containerName, config, cmd: args.join(" ") },
        "Starting vLLM Docker container",
      );
      await $`${args}`;
    },

    async stop(id) {
      const containerName = dockerContainerNameFor(id);
      await $`docker stop ${containerName}`.nothrow();
      await $`docker rm ${containerName}`.nothrow();
    },

    checkHealth,

    async isAlive(id) {
      const result = await $`docker inspect --format={{.State.Status}} ${dockerContainerNameFor(id)}`
        .nothrow()
        .text();
      return result.trim() === "running";
    },

    async getLogs(id, tailLines = 200) {
      try {
        const result = await $`docker logs --tail ${tailLines} ${dockerContainerNameFor(id)} 2>&1`
          .nothrow()
          .text();
        return result.trim();
      } catch {
        return "";
      }
    },

    async getRestartCount(id) {
      const result = await $`docker inspect --format={{.RestartCount}} ${dockerContainerNameFor(id)}`
        .nothrow()
        .text();
      return parseRestartCount(result);
    },

    async ensureSetup() {
      // Ensure cache directories exist with open permissions so the
      // container process (which may run as any uid) can read/write.
      await $`mkdir -p ${env.VLLM_HF_CACHE_DIR} ${env.VLLM_TRITON_CACHE_DIR}`;
      await $`chmod 777 ${env.VLLM_HF_CACHE_DIR} ${env.VLLM_TRITON_CACHE_DIR}`;
    },
  };
}
