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
  test("base config emits stable argv (always egress-blocked + offline)", () => {
    const argv = buildDockerRunArgs("inst-1", baseConfig);
    expect(argv).toEqual([
      "docker", "run", "-d",
      "--name", "vllm-inst-1",
      "--gpus", "all",
      "--ipc=host",
      "--network", "xinity-vllm-noegress-v1",
      "-p", "127.0.0.1:8000:8000",
      "-e", "HF_HOME=/data/hf-cache",
      "-e", "TRITON_CACHE_DIR=/data/triton-cache",
      "-e", "HF_HUB_OFFLINE=1",
      "-e", "TRANSFORMERS_OFFLINE=1",
      "-v", "/var/lib/vllm/hf-cache:/data/hf-cache",
      "-v", "/var/lib/vllm/triton-cache:/data/triton-cache",
      "--restart", "unless-stopped",
      "--entrypoint", "/usr/local/bin/vllm",
      "vllm/vllm-openai:latest",
      "serve", "meta-llama/Llama-3.1-8B-Instruct",
      "--host", "0.0.0.0",
      "--port", "8000",
      "--served-model-name", "meta-llama/Llama-3.1-8B-Instruct",
      "--kv-cache-memory-bytes", "8g",
    ]);
  });

  test("every container is egress-blocked and offline; no mode lets it reach the internet", () => {
    for (const mode of ["daemon", "preview"] as const) {
      const argv = buildDockerRunArgs("inst-1", baseConfig, mode);
      const netIdx = argv.indexOf("--network");
      expect(argv[netIdx + 1]).toBe("xinity-vllm-noegress-v1");
      expect(netIdx).toBeLessThan(argv.indexOf("-p")); // network before published port
      expect(argv).toContain("HF_HUB_OFFLINE=1");
      expect(argv).toContain("TRANSFORMERS_OFFLINE=1");
    }
  });

  test("base image (vllm not the default command) is driven via --entrypoint + serve", () => {
    const argv = buildDockerRunArgs("inst-1", baseConfig);
    const entryIdx = argv.indexOf("--entrypoint");
    expect(argv[entryIdx + 1]).toBe("/usr/local/bin/vllm");
    expect(argv[entryIdx + 2]).toBe("vllm/vllm-openai:latest");
    expect(argv[entryIdx + 3]).toBe("serve");
    expect(argv).not.toContain("--model");
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

  test("preview mode runs detached without a restart policy (one-off, kept for log inspection)", () => {
    const argv = buildDockerRunArgs("inst-1", baseConfig, "preview");
    expect(argv.slice(0, 3)).toEqual(["docker", "run", "-d"]);
    expect(argv).not.toContain("-it");
    expect(argv).not.toContain("--rm");
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
