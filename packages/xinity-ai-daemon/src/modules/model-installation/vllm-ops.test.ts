import { describe, test, expect } from "bun:test";
import {
  buildDockerRunArgs,
  buildSystemdEnvFile,
  buildSystemdServeArgv,
  type VllmInstanceConfig,
} from "./vllm-ops";
import { env } from "../../env";

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
      "-v", `${env.VLLM_HF_CACHE_DIR}:/data/hf-cache`,
      "-v", `${env.VLLM_TRITON_CACHE_DIR}:/data/triton-cache`,
      "--restart", "unless-stopped",
      "--entrypoint", env.VLLM_PATH ?? "vllm",
      env.VLLM_DOCKER_IMAGE!,
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
    expect(argv[entryIdx + 1]).toBe(env.VLLM_PATH ?? "vllm");
    expect(argv[entryIdx + 2]).toBe(env.VLLM_DOCKER_IMAGE);
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

  test("emits the audio decode duration env var only when set", () => {
    const withDuration = buildDockerRunArgs("inst-1", { ...baseConfig, settings: { version: 1, maxAudioInputDurationS: 1200 } });
    const envIdx = withDuration.indexOf("VLLM_MAX_AUDIO_DECODE_DURATION_S=1200");
    expect(envIdx).toBeGreaterThan(0);
    expect(withDuration[envIdx - 1]).toBe("-e");
    expect(envIdx).toBeLessThan(withDuration.indexOf("-v"));

    const without = buildDockerRunArgs("inst-1", baseConfig);
    expect(without.some(a => a.startsWith("VLLM_MAX_AUDIO_DECODE_DURATION_S"))).toBe(false);
  });

  test("emits the audio upload file size env var only when set", () => {
    const withSize = buildDockerRunArgs("inst-1", { ...baseConfig, settings: { version: 1, maxAudioInputFileSizeMB: 50 } });
    const envIdx = withSize.indexOf("VLLM_MAX_AUDIO_CLIP_FILESIZE_MB=50");
    expect(envIdx).toBeGreaterThan(0);
    expect(withSize[envIdx - 1]).toBe("-e");
    expect(envIdx).toBeLessThan(withSize.indexOf("-v"));

    const without = buildDockerRunArgs("inst-1", baseConfig);
    expect(without.some(a => a.startsWith("VLLM_MAX_AUDIO_CLIP_FILESIZE_MB"))).toBe(false);
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
    const lines = out.trimEnd().split("\n");
    expect(lines).toContain("VLLM_MODEL=meta-llama/Llama-3.1-8B-Instruct");
    expect(lines).toContain("VLLM_PORT=8000");
    expect(lines).toContain("VLLM_HOST=127.0.0.1");
    expect(lines).toContain("VLLM_SERVED_MODEL_NAME=meta-llama/Llama-3.1-8B-Instruct");
    expect(lines).toContain("VLLM_KV_CACHE_BYTES=8g");
    if (env.VLLM_PATH) {
      expect(lines).toContain(`VLLM_BINARY_PATH=${env.VLLM_PATH}`);
    }
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

  test("emits the audio decode duration env var only when set", () => {
    const out = buildSystemdEnvFile({ ...baseConfig, settings: { version: 1, maxAudioInputDurationS: 1200 } });
    expect(out).toContain("VLLM_MAX_AUDIO_DECODE_DURATION_S=1200");
    expect(buildSystemdEnvFile(baseConfig)).not.toContain("VLLM_MAX_AUDIO_DECODE_DURATION_S");
  });

  test("emits the audio upload file size env var only when set", () => {
    const out = buildSystemdEnvFile({ ...baseConfig, settings: { version: 1, maxAudioInputFileSizeMB: 50 } });
    expect(out).toContain("VLLM_MAX_AUDIO_CLIP_FILESIZE_MB=50");
    expect(buildSystemdEnvFile(baseConfig)).not.toContain("VLLM_MAX_AUDIO_CLIP_FILESIZE_MB");
  });
});

describe("buildSystemdServeArgv", () => {
  test("base config produces minimal vllm serve argv", () => {
    const binary = env.VLLM_PATH || "/usr/bin/vllm";
    expect(buildSystemdServeArgv(baseConfig)).toEqual([
      binary, "serve", "meta-llama/Llama-3.1-8B-Instruct",
      "--host", "127.0.0.1",
      "--port", "8000",
      "--kv-cache-memory-bytes", "8g",
      "--served-model-name", "meta-llama/Llama-3.1-8B-Instruct",
    ]);
  });

  test("appends gpu utilization, trust flag, and extra args in template order", () => {
    const binary = env.VLLM_PATH || "/usr/bin/vllm";
    expect(buildSystemdServeArgv({
      ...baseConfig,
      gpuMemoryUtilization: 0.9,
      trustRemoteCode: true,
      extraArgs: ["--runner", "pooling", "--enable-auto-tool-choice"],
    })).toEqual([
      binary, "serve", "meta-llama/Llama-3.1-8B-Instruct",
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
