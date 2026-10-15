import { describe, test, expect, mock } from "bun:test";
import { mockDaemonConfig } from "../../mock-config";

mock.module("../../config", () => ({ config: mockDaemonConfig({ VLLM_PATH: "/usr/local/bin/vllm", VLLM_DOCKER_IMAGE: "vllm/vllm-openai:latest", VLLM_HF_TOKEN: "hf_secret" }) }));

const {
  buildDockerRunArgs,
  buildSystemdDropIn,
  buildSystemdEnvFile,
  buildSystemdServeArgv,
  parseDockerMemoryUsage,
  SINGLE_NODE,
} = await import("./vllm-ops");
type VllmInstanceConfig = import("./vllm-ops").VllmInstanceConfig;

const baseConfig: VllmInstanceConfig = {
  model: "meta-llama/Llama-3.1-8B-Instruct",
  port: 8000,
  kvCacheBytes: "8g",
  devices: {
    env: ["CUDA_DEVICE_ORDER=PCI_BUS_ID", "CUDA_VISIBLE_DEVICES=0"],
    supplementaryGroups: [],
    dockerArgs: ["--gpus", "all", "-e", "CUDA_DEVICE_ORDER=PCI_BUS_ID"],
    tensorParallelSize: 1,
  },
  group: SINGLE_NODE,
};

const amdPair = { env: ["ROCR_VISIBLE_DEVICES=GPU-a,GPU-b"], supplementaryGroups: [992, 44], dockerArgs: ["--device", "/dev/kfd"], tensorParallelSize: 2 };

const member = (rank: number) => ({
  kind: "member" as const,
  size: 2,
  rank,
  masterAddr: "10.0.0.1",
  masterPort: 29500,
  rdmaDevices: ["rocep1s0f0", "roceP2p1s0f0"],
  socketInterface: "enP7s7",
});

describe("a member of a node group", () => {
  test("runs on the host network with the RDMA devices and serves on the installation port", () => {
    const argv = buildDockerRunArgs("inst-1", { ...baseConfig, port: 8123, group: member(0) });
    expect(argv).not.toContain("xinity-vllm-noegress-v1");
    expect(argv).not.toContain("-p");
    expect(argv.slice(argv.indexOf("--network"), argv.indexOf("--network") + 6)).toEqual([
      "--network", "host", "--device", "/dev/infiniband", "--ulimit", "memlock=-1:-1",
    ]);
    expect(argv).toContain("NCCL_IB_HCA==rocep1s0f0,roceP2p1s0f0");
    expect(argv).toContain("NCCL_SOCKET_IFNAME=enP7s7");
    expect(argv).toContain("HF_HUB_OFFLINE=1");
    expect(argv.slice(argv.indexOf("--host"), argv.indexOf("--host") + 4)).toEqual(["--host", "127.0.0.1", "--port", "8123"]);
  });

  test("splits tensor parallel across every card of every member", () => {
    const argv = buildSystemdServeArgv({ ...baseConfig, devices: amdPair, group: member(0) });
    expect(argv[argv.indexOf("--tensor-parallel-size") + 1]).toBe("4");
    expect(argv.slice(argv.indexOf("--nnodes"), argv.indexOf("--nnodes") + 8)).toEqual([
      "--nnodes", "2", "--node-rank", "0", "--master-addr", "10.0.0.1", "--master-port", "29500",
    ]);
  });

  test("only rank 0 serves, the others run headless", () => {
    expect(buildSystemdServeArgv({ ...baseConfig, group: member(0) })).not.toContain("--headless");
    expect(buildSystemdServeArgv({ ...baseConfig, group: member(1) })).toContain("--headless");
  });

  test("hands NCCL its devices through the systemd env file too", () => {
    const env = buildSystemdEnvFile({ ...baseConfig, group: member(1) });
    expect(env).toContain("NCCL_IB_HCA==rocep1s0f0,roceP2p1s0f0\n");
    expect(env).toContain("GLOO_SOCKET_IFNAME=enP7s7\n");
  });
});

describe("buildDockerRunArgs", () => {
  test("base config emits stable argv (always egress-blocked + offline)", () => {
    const argv = buildDockerRunArgs("inst-1", baseConfig);
    expect(argv).toEqual([
      "docker", "run", "-d",
      "--name", "vllm-inst-1",
      "--gpus", "all",
      "-e", "CUDA_DEVICE_ORDER=PCI_BUS_ID",
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

  test("every single-node container is egress-blocked and offline; no mode lets it reach the internet", () => {
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

  test("exposes the devices the vendor needs in place of nvidia's", () => {
    const argv = buildDockerRunArgs("inst-1", { ...baseConfig, devices: amdPair });
    expect(argv.slice(5, 7)).toEqual(["--device", "/dev/kfd"]);
    expect(argv).not.toContain("--gpus");
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
  test("keeps hugging face offline for every instance", () => {
    expect(buildSystemdEnvFile(baseConfig)).toBe("HF_HUB_OFFLINE=1\nTRANSFORMERS_OFFLINE=1\nCUDA_DEVICE_ORDER=PCI_BUS_ID\nCUDA_VISIBLE_DEVICES=0\n");
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
  test("runs tensor parallel across the pinned cards, and not at all on one", () => {
    const twoCards = buildSystemdServeArgv({ ...baseConfig, devices: amdPair });
    expect(twoCards[twoCards.indexOf("--tensor-parallel-size") + 1]).toBe("2");
    expect(buildSystemdServeArgv(baseConfig)).not.toContain("--tensor-parallel-size");
  });

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

describe("buildSystemdDropIn", () => {
  test("clears the template's ExecStart and replaces it with the serve argv", () => {
    expect(buildSystemdDropIn(baseConfig)).toBe(
      "[Service]\n" +
      "ExecStart=\n" +
      "ExecStart=\"/usr/local/bin/vllm\" \"serve\" \"meta-llama/Llama-3.1-8B-Instruct\" " +
      "\"--host\" \"127.0.0.1\" \"--port\" \"8000\" \"--kv-cache-memory-bytes\" \"8g\" " +
      "\"--served-model-name\" \"meta-llama/Llama-3.1-8B-Instruct\"\n",
    );
  });

  test("lets the service open the cards' device nodes through their groups", () => {
    expect(buildSystemdDropIn({ ...baseConfig, devices: amdPair })).toStartWith("[Service]\nSupplementaryGroups=992 44\nExecStart=\n");
  });

  test("keeps each extra arg whole through spaces, quotes, newlines and systemd's own expansions", () => {
    const dropIn = buildSystemdDropIn({
      ...baseConfig,
      extraArgs: [
        "--default-chat-template-kwargs", "{\"enable_thinking\": false}",
        "--chat-template", "{%- if x -%}\n\t{{ \"a\\b\" }}\n{%- endif -%}",
        "--x", "$HOME ;",
      ],
    });
    const execStart = dropIn.split("\n")[2]!;
    expect(execStart).toEndWith(
      " \"--default-chat-template-kwargs\" \"{\\\"enable_thinking\\\": false}\"" +
      " \"--chat-template\" \"{%%- if x -%%}\\n\\t{{ \\\"a\\\\b\\\" }}\\n{%%- endif -%%}\"" +
      " \"--x\" \"$$HOME ;\"",
    );
    expect(dropIn.split("\n")).toHaveLength(4);
  });
});

describe("host memory limit", () => {
  const limited = { ...baseConfig, hostMemoryLimitBytes: 5_500_000_000 };

  test("caps the container at the limit and gives it no swap beyond it", () => {
    const argv = buildDockerRunArgs("inst-1", limited);
    expect(argv.slice(argv.indexOf("--memory"), argv.indexOf("--memory") + 4)).toEqual(["--memory", "5500000000", "--memory-swap", "5500000000"]);
  });

  test("caps the service at the limit and gives it no swap", () => {
    expect(buildSystemdDropIn(limited)).toStartWith("[Service]\nMemoryMax=5500000000\nMemorySwapMax=0\nExecStart=\n");
  });

  test("sets no limit when none is given", () => {
    expect(buildDockerRunArgs("inst-1", baseConfig)).not.toContain("--memory");
    expect(buildSystemdDropIn(baseConfig)).not.toContain("MemoryMax");
  });
});

describe("parseDockerMemoryUsage", () => {
  test("reads the usage before the limit in either unit system", () => {
    expect(parseDockerMemoryUsage("1.5GiB / 10GiB\n")).toBe(1.5 * 2 ** 30);
    expect(parseDockerMemoryUsage("812.4MB / 2GB")).toBeCloseTo(812.4e6);
  });

  test("reads nothing from output it does not recognise", () => {
    expect(parseDockerMemoryUsage("")).toBeUndefined();
    expect(parseDockerMemoryUsage("-- / --")).toBeUndefined();
  });
});
