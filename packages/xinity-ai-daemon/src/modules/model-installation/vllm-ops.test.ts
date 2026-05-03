import { describe, test, expect, mock } from "bun:test";

mock.module("../../env", () => ({ env: {
  VLLM_BACKEND: "systemd",
  VLLM_ENV_DIR: "/etc/vllm",
  VLLM_TEMPLATE_UNIT_PATH: "/etc/systemd/system/vllm-driver@.service",
  VLLM_PATH: "/usr/local/bin/vllm",
  VLLM_DOCKER_IMAGE: "vllm/vllm-openai:latest",
  VLLM_HF_CACHE_DIR: "/var/lib/vllm/hf-cache",
  VLLM_TRITON_CACHE_DIR: "/var/lib/vllm/triton-cache",
  VLLM_HF_TOKEN: undefined,
}}));

const {
  buildDockerRunArgs,
  buildSystemdEnvFile,
  buildSystemdServeArgv,
} = await import("./vllm-ops");
type VllmInstanceConfig = import("./vllm-ops").VllmInstanceConfig;

const baseConfig: VllmInstanceConfig = {
  model: "meta-llama/Llama-3.1-8B-Instruct",
  port: 8000,
  kvCacheBytes: "8g",
};

describe("buildDockerRunArgs", () => {
  test("base config emits stable argv", () => {
    const argv = buildDockerRunArgs("inst-1", baseConfig);
    expect(argv).toEqual([
      "docker", "run", "-d",
      "--name", "vllm-inst-1",
      "--gpus", "all",
      "--ipc=host",
      "-p", "127.0.0.1:8000:8000",
      "-e", "HF_HOME=/data/hf-cache",
      "-e", "TRITON_CACHE_DIR=/data/triton-cache",
      "-v", "/var/lib/vllm/hf-cache:/data/hf-cache",
      "-v", "/var/lib/vllm/triton-cache:/data/triton-cache",
      "--restart", "unless-stopped",
      "vllm/vllm-openai:latest",
      "--model", "meta-llama/Llama-3.1-8B-Instruct",
      "--served-model-name", "meta-llama/Llama-3.1-8B-Instruct",
      "--kv-cache-memory-bytes", "8g",
    ]);
  });

  test("appends optional flags in the documented order", () => {
    const argv = buildDockerRunArgs("inst-1", {
      ...baseConfig,
      gpuMemoryUtilization: 0.85,
      trustRemoteCode: true,
      extraArgs: ["--runner", "pooling", "--enable-auto-tool-choice"],
    });
    const tail = argv.slice(argv.indexOf("--kv-cache-memory-bytes") + 2);
    expect(tail).toEqual([
      "--gpu-memory-utilization", "0.85",
      "--trust-remote-code",
      "--runner", "pooling",
      "--enable-auto-tool-choice",
    ]);
  });

  test("preview mode swaps -d for -it --rm and drops the restart policy", () => {
    const argv = buildDockerRunArgs("inst-1", baseConfig, "preview");
    expect(argv.slice(0, 5)).toEqual(["docker", "run", "-it", "--rm", "--name"]);
    expect(argv).not.toContain("-d");
    expect(argv).not.toContain("--restart");
    expect(argv).not.toContain("unless-stopped");
  });
});

describe("buildSystemdEnvFile", () => {
  test("base config writes only the required variables", () => {
    const out = buildSystemdEnvFile(baseConfig);
    expect(out).toBe(
      "VLLM_MODEL=meta-llama/Llama-3.1-8B-Instruct\n" +
      "VLLM_PORT=8000\n" +
      "VLLM_HOST=127.0.0.1\n" +
      "VLLM_SERVED_MODEL_NAME=meta-llama/Llama-3.1-8B-Instruct\n" +
      "VLLM_KV_CACHE_BYTES=8g\n" +
      "VLLM_BINARY_PATH=/usr/local/bin/vllm\n",
    );
  });

  test("emits trust-remote-code, gpu-mem, and extra args when present", () => {
    const out = buildSystemdEnvFile({
      ...baseConfig,
      trustRemoteCode: true,
      gpuMemoryUtilization: 0.85,
      extraArgs: ["--runner", "pooling"],
    });
    expect(out).toContain("VLLM_TRUST_REMOTE_CODE=true");
    expect(out).toContain("VLLM_GPU_MEMORY_UTILIZATION=0.85");
    expect(out).toContain("VLLM_EXTRA_ARGS=--runner pooling");
  });
});

describe("buildSystemdServeArgv", () => {
  test("base config produces minimal vllm serve argv", () => {
    expect(buildSystemdServeArgv(baseConfig)).toEqual([
      "/usr/local/bin/vllm", "serve", "meta-llama/Llama-3.1-8B-Instruct",
      "--host", "127.0.0.1",
      "--port", "8000",
      "--kv-cache-memory-bytes", "8g",
      "--served-model-name", "meta-llama/Llama-3.1-8B-Instruct",
    ]);
  });

  test("appends gpu utilization, trust flag, and extra args in template order", () => {
    expect(buildSystemdServeArgv({
      ...baseConfig,
      gpuMemoryUtilization: 0.9,
      trustRemoteCode: true,
      extraArgs: ["--runner", "pooling", "--enable-auto-tool-choice"],
    })).toEqual([
      "/usr/local/bin/vllm", "serve", "meta-llama/Llama-3.1-8B-Instruct",
      "--host", "127.0.0.1",
      "--port", "8000",
      "--kv-cache-memory-bytes", "8g",
      "--served-model-name", "meta-llama/Llama-3.1-8B-Instruct",
      "--gpu-memory-utilization", "0.9",
      "--trust-remote-code",
      "--runner", "pooling",
      "--enable-auto-tool-choice",
    ]);
  });
});
