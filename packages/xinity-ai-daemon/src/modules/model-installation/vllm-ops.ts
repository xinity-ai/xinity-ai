import { $ } from "bun";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { config as daemonConfig } from "../../config";
// @ts-expect-error Bun text import
import templateUnit from "../../assets/vllm-driver@.service" with { type: "text" };
import { rootLogger } from "../../logger";
import { resolveMaxAudioInputDurationS, resolveMaxAudioInputFileSizeMB, type DeploymentSettings } from "common-env";
import type { GpuDevices } from "./gpu-devices";

const log = rootLogger.child({ name: "vllm-ops" });

export type VllmInstanceConfig = {
  model: string;
  port: number;
  kvCacheBytes: string;
  trustRemoteCode?: boolean;
  extraArgs?: string[];
  gpuMemoryUtilization?: number;
  settings?: DeploymentSettings | null;
  devices: GpuDevices;
  group: NodeGroup;
  hostMemoryLimitBytes?: number;
}

export type CoupledPath = { subnet: string; address: string; interface: string; rdmaDevice: string };

export type NodeGroup =
  | { kind: "single" }
  | {
      kind: "member";
      size: number;
      rank: number;
      masterAddr: string;
      masterPort: number;
      // This node's own interfaces and devices, so they differ per member. The one toward rank 0 first.
      paths: CoupledPath[];
    };

export const SINGLE_NODE: NodeGroup = { kind: "single" };

type GroupLaunch<Group extends NodeGroup> = {
  size: (group: Group) => number;
  restartsAlone: boolean;
  serveArgs: (group: Group) => string[];
  systemdEnv: (group: Group) => string[];
  systemdUnitLines: (group: Group) => string[];
  docker: (group: Group, port: number) => { networkArgs: string[]; env: string[]; host: string; port: number };
};

const COUPLING_NETWORK_PREFIX = "xinity-coupling-";

const couplingNetworkName = (path: CoupledPath) =>
  `${COUPLING_NETWORK_PREFIX}${path.interface}-${path.subnet.replace(/[./]/g, "-")}`
    // Docker lowercases the name when a container joins by name=.
    .toLowerCase();

const couplingInterface = (index: number) => `coupl${index}`;

const rdmaDevicesEnv = (group: Extract<NodeGroup, { kind: "member" }>) => `NCCL_IB_HCA==${group.paths.map((path) => path.rdmaDevice).join(",")}`;

export const pathCidr = (path: CoupledPath) => `${path.address}/${path.subnet.split("/")[1]}`;

// Without VLLM_HOST_IP, vLLM announces its message queue on another address, such as Docker's bridge, which the other members cannot reach.
const memberEnv = (group: Extract<NodeGroup, { kind: "member" }>, socketInterface: string) => [
  rdmaDevicesEnv(group),
  `NCCL_SOCKET_IFNAME=${socketInterface}`,
  `GLOO_SOCKET_IFNAME=${socketInterface}`,
  `VLLM_HOST_IP=${group.paths[0]!.address}`,
];

const GROUP_LAUNCH: { [Kind in NodeGroup["kind"]]: GroupLaunch<Extract<NodeGroup, { kind: Kind }>> } = {
  single: {
    size: () => 1,
    restartsAlone: true,
    serveArgs: () => [],
    systemdEnv: () => [],
    systemdUnitLines: () => [],
    docker: (_group, port) => ({ networkArgs: ["--network", VLLM_NETWORK, "-p", `127.0.0.1:${port}:8000`], env: [], host: "0.0.0.0", port: 8000 }),
  },
  member: {
    size: (group) => group.size,
    // A member restarted on its own finds no group to rejoin, so the group restarts as one instead.
    restartsAlone: false,
    serveArgs: (group) => [
      "--nnodes", String(group.size),
      "--node-rank", String(group.rank),
      "--master-addr", group.masterAddr,
      "--master-port", String(group.masterPort),
      ...(group.rank > 0 ? ["--headless"] : []),
    ],
    systemdEnv: (group) => memberEnv(group, group.paths[0]!.interface),
    systemdUnitLines: (group) => group.paths.flatMap((path) => {
      const ip = Bun.which("ip") ?? "ip";
      const address = pathCidr(path);
      // The unit holds its member addresses on the host interfaces exactly as long as it runs, across restarts too.
      return [`ExecStartPre=+${ip} addr replace ${address} dev ${path.interface}`, `ExecStopPost=-${ip} addr del ${address} dev ${path.interface}`];
    }),
    docker: (group, port) => ({
      networkArgs: [
        "--network", VLLM_NETWORK,
        ...group.paths.flatMap((path, index) => [
          "--network", `name=${couplingNetworkName(path)},ip=${path.address},driver-opt=com.docker.network.endpoint.ifname=${couplingInterface(index)}`,
        ]),
        "-p", `127.0.0.1:${port}:8000`,
        "--device", "/dev/infiniband",
        "--ulimit", "memlock=-1:-1",
      ],
      env: memberEnv(group, couplingInterface(0)),
      host: "0.0.0.0",
      port: 8000,
    }),
  },
};

function launchOf(group: NodeGroup): GroupLaunch<NodeGroup> {
  return GROUP_LAUNCH[group.kind] as GroupLaunch<NodeGroup>;
}

export function groupTensorParallelSize(config: Pick<VllmInstanceConfig, "devices" | "group">): number {
  return config.devices.tensorParallelSize * launchOf(config.group).size(config.group);
}

export type VllmOps = {
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
  /** Host memory the instance uses now and the limit it runs under, in bytes, or undefined when they cannot be read */
  memoryUse(id: string): Promise<MemoryUse | undefined>;
  /** Whether the instance went over its memory limit since it was started, across the runtime's own restarts */
  wasOomKilled(id: string): Promise<boolean>;
  /** One-time setup (install systemd template / ensure docker image availability) */
  ensureSetup(): Promise<void>;
}

async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function parseRestartCount(raw: string): number {
  const count = parseInt(raw.trim(), 10);
  return Number.isNaN(count) ? 0 : count;
}

export type MemoryUse = { usedBytes: number; limitBytes?: number };

const MEMORY_UNITS: Record<string, number> = { B: 1, KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30, TiB: 2 ** 40, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

export function parseDockerMemoryUsage(raw: string): number | undefined {
  const match = /^([\d.]+)\s*([A-Za-z]+)\s*\//.exec(raw.trim());
  const unit = match && MEMORY_UNITS[match[2]!];
  return unit ? Number(match[1]) * unit : undefined;
}

function nonEmptyLines(raw: string): string[] {
  return raw.split("\n").map((line) => line.trim()).filter(Boolean);
}

const OFFLINE_ENV = ["HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1"];

// ---------------------------------------------------------------------------
// Systemd implementation
// ---------------------------------------------------------------------------

export function buildSystemdEnvFile(config: VllmInstanceConfig): string {
  const lines: string[] = [...OFFLINE_ENV, ...config.devices.env, ...launchOf(config.group).systemdEnv(config.group)];
  const audioDuration = resolveMaxAudioInputDurationS(config.settings);
  if (audioDuration != null) {
    lines.push(`VLLM_MAX_AUDIO_DECODE_DURATION_S=${audioDuration}`);
  }
  const audioFileSize = resolveMaxAudioInputFileSizeMB(config.settings);
  if (audioFileSize != null) {
    lines.push(`VLLM_MAX_AUDIO_CLIP_FILESIZE_MB=${audioFileSize}`);
  }
  return lines.join("\n") + "\n";
}

/** Append CLI flags that are identical between the systemd and docker vLLM commands. */
function appendVllmCommonArgs(args: string[], config: VllmInstanceConfig): void {
  if (config.gpuMemoryUtilization != null) {
    args.push("--gpu-memory-utilization", String(config.gpuMemoryUtilization));
  }
  const tensorParallelSize = groupTensorParallelSize(config);
  if (tensorParallelSize > 1) {
    args.push("--tensor-parallel-size", String(tensorParallelSize));
  }
  args.push(...launchOf(config.group).serveArgs(config.group));
  if (config.trustRemoteCode) {
    args.push("--trust-remote-code");
  }
  if (config.extraArgs && config.extraArgs.length > 0) {
    args.push(...config.extraArgs);
  }
}

export function buildSystemdServeArgv(config: VllmInstanceConfig): string[] {
  const binary = daemonConfig.vllm.path || "/usr/bin/vllm";
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

// systemd.syntax(5) quoting, plus the "$" and "%" that ExecStart= would otherwise expand.
const SYSTEMD_ESCAPES: Record<string, string> = {
  "\\": "\\\\", "\"": "\\\"", "\n": "\\n", "\r": "\\r", "\t": "\\t", "$": "$$", "%": "%%",
};

function quoteSystemdArg(arg: string): string {
  return `"${arg.replace(/[\\"\n\r\t$%]/g, (char) => SYSTEMD_ESCAPES[char]!)}"`;
}

// The empty ExecStart= clears the template's, which only units started before drop-ins still use.
export function buildSystemdDropIn(config: VllmInstanceConfig): string {
  const execStart = buildSystemdServeArgv(config).map(quoteSystemdArg).join(" ");
  const { supplementaryGroups } = config.devices;
  const groupsLine = supplementaryGroups.length > 0 ? `SupplementaryGroups=${supplementaryGroups.join(" ")}\n` : "";
  // Swap would turn going over the limit into a slow node instead of a stopped installation.
  const memoryLines = config.hostMemoryLimitBytes ? `MemoryMax=${config.hostMemoryLimitBytes}\nMemorySwapMax=0\n` : "";
  const launch = launchOf(config.group);
  const unitLines = [...(launch.restartsAlone ? [] : ["Restart=no"]), ...launch.systemdUnitLines(config.group)].map((line) => `${line}\n`).join("");
  return `[Service]\n${groupsLine}${memoryLines}${unitLines}ExecStart=\nExecStart=${execStart}\n`;
}

const SYSTEMD_UNIT_INSTANCE_RE = /^vllm-driver@(.+)\.service$/;
const systemdUnitFor = (id: string) => `vllm-driver@${id}.service`;
const systemdDropInDirFor = (id: string) =>
  `${dirname(daemonConfig.vllm.templateUnitPath)}/${systemdUnitFor(id)}.d`;

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
      await $`mkdir -p ${daemonConfig.vllm.envDir}`;
      const envPath = `${daemonConfig.vllm.envDir}/${id}.env`;
      const envContent = buildSystemdEnvFile(config);
      log.info(
        { id, envPath, config },
        "Starting vLLM systemd service",
      );
      await Bun.write(envPath, envContent);
      await $`chmod 600 ${envPath}`;
      const dropInDir = systemdDropInDirFor(id);
      await $`mkdir -p ${dropInDir}`;
      await Bun.write(`${dropInDir}/serve.conf`, buildSystemdDropIn(config));
      await $`systemctl daemon-reload`;
      await $`systemctl enable --now ${systemdUnitFor(id)}`;
    },

    async stop(id) {
      await $`systemctl disable --now ${systemdUnitFor(id)}`.nothrow();
      await $`rm -f ${daemonConfig.vllm.envDir}/${id}.env`;
      await $`rm -rf ${systemdDropInDirFor(id)}`;
      await $`systemctl daemon-reload`.nothrow();
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

    async memoryUse(id) {
      const result = await $`systemctl show -p MemoryCurrent -p MemoryMax --value ${systemdUnitFor(id)}`.nothrow().text();
      const [used, limit] = result.trim().split("\n").map(Number);
      if (!Number.isFinite(used)) {
        return undefined;
      }
      return { usedBytes: used!, limitBytes: Number.isFinite(limit) ? limit : undefined };
    },

    async wasOomKilled(id) {
      const startedAt = (await stat(`${systemdDropInDirFor(id)}/serve.conf`).catch(() => undefined))?.mtimeMs;
      if (startedAt === undefined) {
        return false;
      }
      const since = `@${Math.floor(startedAt / 1000)}`;
      const result = await $`journalctl -u ${systemdUnitFor(id)} --since ${since} --grep oom-kill -n 1 -o cat --no-pager`.nothrow().text();
      return result.trim().length > 0;
    },

    async ensureSetup() {
      const targetPath = daemonConfig.vllm.templateUnitPath;
      const existing = await Bun.file(targetPath).text().catch(() => null);
      if (existing === templateUnit) {
        log.debug({ targetPath }, "vLLM systemd template up to date, skipping");
      } else {
        await Bun.write(targetPath, templateUnit);
        await $`systemctl daemon-reload`;
        log.info({ targetPath, replaced: existing != null }, "Installed vLLM systemd template unit");
      }

      // Ensure cache and env directories exist with correct ownership.
      // The vllm-driver@ template runs as User=vllm with
      // ReadWritePaths=/var/lib/vllm, so these must be pre-created.
      await $`mkdir -p ${daemonConfig.vllm.hfCacheDir} ${daemonConfig.vllm.tritonCacheDir} ${daemonConfig.vllm.envDir}`;
      await $`chown -R vllm:vllm ${daemonConfig.vllm.hfCacheDir} ${daemonConfig.vllm.tritonCacheDir}`.nothrow();
    },
  };
}

// ---------------------------------------------------------------------------
// Docker implementation
// ---------------------------------------------------------------------------

const DOCKER_CONTAINER_PREFIX = "vllm-";
const dockerContainerNameFor = (id: string) => `${DOCKER_CONTAINER_PREFIX}${id}`;

// Egress-blocked (masquerade off). Bump the -vN suffix to roll out changed network settings.
export const VLLM_NETWORK = "xinity-vllm-noegress-v1";

export async function ensureVllmNetwork(): Promise<void> {
  const present = await $`docker network inspect ${VLLM_NETWORK}`.quiet().nothrow();
  if (present.exitCode === 0) return;
  await $`docker network create -o com.docker.network.bridge.enable_ip_masquerade=false ${VLLM_NETWORK}`.quiet();
  log.info({ network: VLLM_NETWORK }, "Created egress-blocked vLLM docker network");
}

export const couplingNetworkCreateArgs = (path: CoupledPath) => [
  "network", "create", "-d", "ipvlan", "-o", "ipvlan_mode=l2", "-o", `parent=${path.interface}`,
  // Internal, so a member reaches the other members on the coupling and nothing beyond it.
  "--internal",
  "--subnet", path.subnet, couplingNetworkName(path),
];

async function couplingNetworksOn(parent: string): Promise<string[]> {
  const names = nonEmptyLines(await $`docker network ls --filter name=${COUPLING_NETWORK_PREFIX} --format {{.Name}}`.nothrow().text());
  const parentFormat = "{{index .Options \"parent\"}}";
  const parents = await Promise.all(names.map(async (name) => (await $`docker network inspect --format ${parentFormat} ${name}`.nothrow().text()).trim()));
  return names.filter((_name, index) => parents[index] === parent);
}

export async function ensureCouplingNetworks(paths: CoupledPath[]): Promise<void> {
  for (const path of paths) {
    const name = couplingNetworkName(path);
    if ((await $`docker network inspect ${name}`.quiet().nothrow()).exitCode === 0) {
      continue;
    }
    // Docker takes one ipvlan network per parent interface, so one left from the port's former subnet blocks this one.
    for (const former of await couplingNetworksOn(path.interface)) {
      await $`docker network rm ${former}`.quiet().nothrow();
      log.info({ network: former }, "Removed coupling network of a former subnet");
    }
    await $`docker ${couplingNetworkCreateArgs(path)}`.quiet();
    log.info({ network: name }, "Created coupling network");
  }
}

export function buildDockerRunArgs(
  id: string,
  config: VllmInstanceConfig,
  mode: "daemon" | "preview" = "daemon",
): string[] {
  const dockerImage = daemonConfig.vllm.dockerImage;
  if (!dockerImage) {
    throw new Error("VLLM_DOCKER_IMAGE must be set to build a docker run command");
  }
  const containerName = dockerContainerNameFor(id);
  const audioDuration = resolveMaxAudioInputDurationS(config.settings);
  const audioFileSize = resolveMaxAudioInputFileSizeMB(config.settings);
  const launch = launchOf(config.group);
  const network = launch.docker(config.group, config.port);
  const args = [
    "docker", "run", "-d",
    "--name", containerName,
    ...config.devices.dockerArgs,
    "--ipc=host",
    ...(config.hostMemoryLimitBytes ? ["--memory", String(config.hostMemoryLimitBytes), "--memory-swap", String(config.hostMemoryLimitBytes)] : []),
    ...network.networkArgs,
    ...network.env.flatMap((entry) => ["-e", entry]),
    "-e", "HF_HOME=/data/hf-cache",
    "-e", "TRITON_CACHE_DIR=/data/triton-cache",
    ...OFFLINE_ENV.flatMap((entry) => ["-e", entry]),
    ...(audioDuration != null
      ? ["-e", `VLLM_MAX_AUDIO_DECODE_DURATION_S=${audioDuration}`]
      : []),
    ...(audioFileSize != null
      ? ["-e", `VLLM_MAX_AUDIO_CLIP_FILESIZE_MB=${audioFileSize}`]
      : []),
    "-v", `${daemonConfig.vllm.hfCacheDir}:/data/hf-cache`,
    "-v", `${daemonConfig.vllm.tritonCacheDir}:/data/triton-cache`,
    ...(mode === "daemon" && launch.restartsAlone ? ["--restart", "unless-stopped"] : []),
    "--entrypoint", daemonConfig.vllm.path ?? "vllm",
    dockerImage,
    "serve", config.model,
    "--host", network.host,
    "--port", String(network.port),
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

      await ensureVllmNetwork();
      if (config.group.kind === "member") {
        await ensureCouplingNetworks(config.group.paths);
      }
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

    async memoryUse(id) {
      const name = dockerContainerNameFor(id);
      const [stats, limit] = await Promise.all([
        $`docker stats --no-stream --format {{.MemUsage}} ${name}`.nothrow().text(),
        $`docker inspect --format={{.HostConfig.Memory}} ${name}`.nothrow().text(),
      ]);
      const usedBytes = parseDockerMemoryUsage(stats);
      const limitBytes = Number(limit.trim());
      return usedBytes === undefined ? undefined : { usedBytes, limitBytes: limitBytes > 0 ? limitBytes : undefined };
    },

    // Docker keeps too few events to remember a kill, so the kernel's record of it is read, which
    // names the container's cgroup.
    async wasOomKilled(id) {
      const format = "{{.Id}} {{.Created}}";
      const [containerId, created] = (await $`docker inspect --format=${format} ${dockerContainerNameFor(id)}`.nothrow().text()).trim().split(" ");
      const createdAt = Date.parse((created ?? "").replace(/(\.\d{3})\d+/, "$1"));
      if (!containerId || Number.isNaN(createdAt)) {
        return false;
      }
      const since = `@${Math.floor(createdAt / 1000)}`;
      const pattern = `oom-kill.*${containerId}`;
      const result = await $`journalctl -k --since ${since} --grep ${pattern} -n 1 -o cat --no-pager`.nothrow().text();
      return result.trim().length > 0;
    },

    async ensureSetup() {
      // Ensure cache directories exist with open permissions so the
      // container process (which may run as any uid) can read/write.
      await $`mkdir -p ${daemonConfig.vllm.hfCacheDir} ${daemonConfig.vllm.tritonCacheDir}`;
      await $`chmod 777 ${daemonConfig.vllm.hfCacheDir} ${daemonConfig.vllm.tritonCacheDir}`;
    },
  };
}
