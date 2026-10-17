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
  masterAddr: "192.168.100.1",
  masterPort: 29500,
  paths: [
    { subnet: "192.168.100.0/24", address: `192.168.100.${rank + 1}`, interface: "enp1s0f0np0", rdmaDevice: "rocep1s0f0" },
    { subnet: "192.168.101.0/24", address: `192.168.101.${rank + 1}`, interface: "enP2p1s0f0np0", rdmaDevice: "roceP2p1s0f0" },
  ],
});

describe("a member of a node group", () => {
  test("stays on the egress-blocked network and joins the coupling on each path with its own address", () => {
    const argv = buildDockerRunArgs("inst-1", { ...baseConfig, port: 8123, group: member(1) });
    expect(argv).not.toContain("host");
    expect(argv.slice(argv.indexOf("--network"), argv.indexOf("--network") + 12)).toEqual([
      "--network", "xinity-vllm-noegress-v1",
      "--network", "name=xinity-coupling-enp1s0f0np0-192-168-100-0-24,ip=192.168.100.2,driver-opt=com.docker.network.endpoint.ifname=coupl0",
      "--network", "name=xinity-coupling-enp2p1s0f0np0-192-168-101-0-24,ip=192.168.101.2,driver-opt=com.docker.network.endpoint.ifname=coupl1",
      "-p", "127.0.0.1:8123:8000",
      "--device", "/dev/infiniband",
      "--ulimit", "memlock=-1:-1",
    ]);
    expect(argv).toContain("NCCL_IB_HCA==rocep1s0f0,roceP2p1s0f0");
    expect(argv).toContain("NCCL_SOCKET_IFNAME=coupl0");
    expect(argv).toContain("VLLM_HOST_IP=192.168.100.2");
    expect(argv).toContain("HF_HUB_OFFLINE=1");
  });

  test("splits tensor parallel across every card of every member", () => {
    const argv = buildSystemdServeArgv({ ...baseConfig, devices: amdPair, group: member(0) });
    expect(argv[argv.indexOf("--tensor-parallel-size") + 1]).toBe("4");
    expect(argv.slice(argv.indexOf("--nnodes"), argv.indexOf("--nnodes") + 8)).toEqual([
      "--nnodes", "2", "--node-rank", "0", "--master-addr", "192.168.100.1", "--master-port", "29500",
    ]);
  });

  test("only rank 0 serves, the others run headless", () => {
    expect(buildSystemdServeArgv({ ...baseConfig, group: member(0) })).not.toContain("--headless");
    expect(buildSystemdServeArgv({ ...baseConfig, group: member(1) })).toContain("--headless");
  });

  test("hands NCCL its devices and the member its address through the systemd env file too", () => {
    const env = buildSystemdEnvFile({ ...baseConfig, group: member(1) });
    expect(env).toContain("NCCL_IB_HCA==rocep1s0f0,roceP2p1s0f0\n");
    expect(env).toContain("GLOO_SOCKET_IFNAME=enp1s0f0np0\n");
    expect(env).toContain("VLLM_HOST_IP=192.168.100.2\n");
  });

  test("holds the member addresses on the host interfaces for as long as the unit runs", () => {
    const lines = buildSystemdDropIn({ ...baseConfig, group: member(1) }).split("\n").filter((line) => line.startsWith("ExecStartPre=") || line.startsWith("ExecStopPost="));
    expect(lines.map((line) => line.replace(/=[+-]\S*ip /, "= ip "))).toEqual([
      "ExecStartPre= ip addr replace 192.168.100.2/24 dev enp1s0f0np0",
      "ExecStopPost= ip addr del 192.168.100.2/24 dev enp1s0f0np0",
      "ExecStartPre= ip addr replace 192.168.101.2/24 dev enP2p1s0f0np0",
      "ExecStopPost= ip addr del 192.168.101.2/24 dev enP2p1s0f0np0",
    ]);
    expect(lines[0]).toMatch(/^ExecStartPre=\+/);
    expect(lines[1]).toMatch(/^ExecStopPost=-/);
  });

  test("leaves restarting a member to its group, on both backends, while a single installation restarts on its own", () => {
    expect(buildSystemdDropIn({ ...baseConfig, group: member(1) })).toContain("\nRestart=no\n");
    expect(buildSystemdDropIn(baseConfig)).not.toContain("Restart=");
    expect(buildDockerRunArgs("inst-1", { ...baseConfig, group: member(1) })).not.toContain("--restart");
    expect(buildDockerRunArgs("inst-1", baseConfig)).toContain("unless-stopped");
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

  test("every container is egress-blocked and offline, members of a group too; no mode lets it reach the internet", () => {
    for (const [mode, group] of [["daemon", SINGLE_NODE], ["preview", SINGLE_NODE], ["daemon", member(0)]] as const) {
      const argv = buildDockerRunArgs("inst-1", { ...baseConfig, group }, mode);
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
