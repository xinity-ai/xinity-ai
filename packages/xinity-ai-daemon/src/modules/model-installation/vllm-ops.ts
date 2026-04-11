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

// ---------------------------------------------------------------------------
// Systemd implementation
// ---------------------------------------------------------------------------

function buildEnvFileContent(config: VllmInstanceConfig): string {
  const lines = [
    `VLLM_MODEL=${config.model}`,
    `VLLM_PORT=${config.port}`,
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

export function createSystemdVllmOps(): VllmOps {
  return {
    async listRunning() {
      const result =
        await $`systemctl list-units 'vllm-driver@*' --type=service --state=active --no-legend --plain`
          .nothrow()
          .text();

      // Each line looks like: vllm-driver@<id>.service loaded active running ...
      return result
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const unit = line.split(/\s+/)[0];
          const match = unit.match(/^vllm-driver@(.+)\.service$/);
          return match?.[1];
        })
        .filter((id): id is string => id != null);
    },

    async start(id, config) {
      await $`mkdir -p ${env.VLLM_ENV_DIR}`;
      const envPath = `${env.VLLM_ENV_DIR}/${id}.env`;
      const envContent = buildEnvFileContent(config);
      log.info(
        { id, envPath, config },
        "Starting vLLM systemd service",
      );
      await Bun.write(envPath, envContent);
      await $`chmod 644 ${envPath}`;
      await $`systemctl enable --now vllm-driver@${id}.service`;
    },

    async stop(id) {
      await $`systemctl disable --now vllm-driver@${id}.service`.nothrow();
      await $`rm -f ${env.VLLM_ENV_DIR}/${id}.env`;
    },

    async checkHealth(port) {
      try {
        const res = await fetch(`http://localhost:${port}/health`);
        return res.ok;
      } catch {
        return false;
      }
    },

    async isAlive(id) {
      const result = await $`systemctl is-active vllm-driver@${id}.service`
        .nothrow()
        .text();
      return result.trim() === "active";
    },

    async getLogs(id, tailLines = 200) {
      try {
        const result = await $`journalctl -u vllm-driver@${id}.service --no-pager -n ${tailLines} --output=short-iso`
          .nothrow()
          .text();
        return result.trim();
      } catch {
        return "";
      }
    },

    async getRestartCount(id) {
      const result = await $`systemctl show -p NRestarts --value vllm-driver@${id}.service`
        .nothrow()
        .text();
      const count = parseInt(result.trim(), 10);
      return Number.isNaN(count) ? 0 : count;
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

export function createDockerVllmOps(): VllmOps {
  return {
    async listRunning() {
      const result =
        await $`docker ps --filter name=${DOCKER_CONTAINER_PREFIX} --format '{{.Names}}'`
          .text();

      return result
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => name.startsWith(DOCKER_CONTAINER_PREFIX) ? name.slice(DOCKER_CONTAINER_PREFIX.length) : name);
    },

    async start(id, config) {
      const containerName = `${DOCKER_CONTAINER_PREFIX}${id}`;
      // Remove any existing stopped/exited container with this name
      await $`docker rm -f ${containerName}`.nothrow();

      const args = [
        "docker", "run", "-d",
        "--name", containerName,
        "--gpus", "all",
        "--ipc=host",
        "-p", `${config.port}:8000`,
        "-e", "HF_HOME=/data/hf-cache",
        "-e", "TRITON_CACHE_DIR=/data/triton-cache",
        "-v", `${env.VLLM_HF_CACHE_DIR}:/data/hf-cache`,
        "-v", `${env.VLLM_TRITON_CACHE_DIR}:/data/triton-cache`,
        "--restart", "unless-stopped",
        env.VLLM_DOCKER_IMAGE,
        "--model", config.model,
        "--served-model-name", config.model,
        "--kv-cache-memory-bytes", config.kvCacheBytes,
      ];
      if (config.gpuMemoryUtilization != null) {
        args.push("--gpu-memory-utilization", String(config.gpuMemoryUtilization));
      }
      if (config.trustRemoteCode) {
        args.push("--trust-remote-code");
      }
      if (config.extraArgs && config.extraArgs.length > 0) {
        args.push(...config.extraArgs);
      }

      log.info(
        { id, containerName, config, cmd: args.join(" ") },
        "Starting vLLM Docker container",
      );
      await $`${args}`;
    },

    async stop(id) {
      const containerName = `${DOCKER_CONTAINER_PREFIX}${id}`;
      await $`docker stop ${containerName}`.nothrow();
      await $`docker rm ${containerName}`.nothrow();
    },

    async checkHealth(port) {
      try {
        const res = await fetch(`http://localhost:${port}/health`);
        return res.ok;
      } catch {
        return false;
      }
    },

    async isAlive(id) {
      const containerName = `${DOCKER_CONTAINER_PREFIX}${id}`;
      const result = await $`docker inspect --format={{.State.Status}} ${containerName}`
        .nothrow()
        .text();
      return result.trim() === "running";
    },

    async getLogs(id, tailLines = 200) {
      try {
        const containerName = `${DOCKER_CONTAINER_PREFIX}${id}`;
        const result = await $`docker logs --tail ${tailLines} ${containerName} 2>&1`
          .nothrow()
          .text();
        return result.trim();
      } catch {
        return "";
      }
    },

    async getRestartCount(id) {
      const containerName = `${DOCKER_CONTAINER_PREFIX}${id}`;
      const result = await $`docker inspect --format={{.RestartCount}} ${containerName}`
        .nothrow()
        .text();
      const count = parseInt(result.trim(), 10);
      return Number.isNaN(count) ? 0 : count;
    },

    async ensureSetup() {
      // Ensure cache directories exist with open permissions so the
      // container process (which may run as any uid) can read/write.
      await $`mkdir -p ${env.VLLM_HF_CACHE_DIR} ${env.VLLM_TRITON_CACHE_DIR}`;
      await $`chmod 777 ${env.VLLM_HF_CACHE_DIR} ${env.VLLM_TRITON_CACHE_DIR}`;
    },
  };
}
