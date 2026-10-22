/**
 * Standalone vLLM model runner: resolves a model entry against this machine, gates
 * on the installed vLLM version/platform, downloads the model files, and starts/stops
 * the server. Needs no daemon, database, or cluster; it reuses the daemon's own command
 * builders and downloader so a run here matches a daemon-managed install. See --help.
 */
import { parseArgs } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { z } from "zod";
import { chargedAgainstCards, freeMemberAddress, maxNumSeqs, quoteShellArgv, sharesHostMemory } from "common-env";
import {
  ModelFileSchema,
  estimateThroughput,
  estimateConcurrency,
  type ConcurrencyEstimate,
} from "common-env/model-catalog";
import {
  resolveVllmModel,
  checkVllmCompatibility,
  describeIncompatibility,
  RunModelError,
  chargeOnNode,
  type ResolvedVllmModel,
  type VllmDriverState,
} from "./lib/vllm-run";
import type { NodeGroup, VllmInstanceConfig } from "../modules/model-installation/vllm-ops";
import type { HardwareProfile } from "../modules/hardware-detect";
import type { CardShare, NodeCharge } from "../modules/model-installation/vllm";

const DEFAULT_PORT = 8000;
const DEFAULT_MASTER_PORT = 29500;

let jsonMode = false;

function die(msg: string, code?: string): never {
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, error: msg, ...(code ? { code } : {}) }));
  } else {
    console.error(`error: ${msg}`);
  }
  process.exit(1);
}

function emit(record: Record<string, unknown>): void {
  if (jsonMode) console.log(JSON.stringify(record));
}

const HELP = [
  "Resolve, gate, download and run a vLLM model on this machine.",
  "",
  "Required:",
  "  --models <file>     Model file (YAML or JSON, xinity-infoserver model shape)",
  "  --model  <name>     Public specifier (key in models:) or an engineSpecifier value",
  "",
  "Verb (default --plan):",
  "  --plan              Print the plan (gate result, serve command, stop hint). No side effects.",
  "  --download          Resolve and download the model files into the HF cache.",
  "  --start             Gate, ensure files are downloaded, then start the server. With the docker",
  "                      backend the container runs detached; the command prints a `docker logs -f`",
  "                      line to follow the load and the stop command, then returns.",
  "  --stop              Stop a server previously started with the same --id.",
  "",
  "Flags:",
  "  --image <ref>       Use docker with this image instead of a bare vllm process.",
  "  --vllm-path <path>  vllm binary for the bare backend (default: $VLLM_PATH or `vllm` on PATH).",
  "  --port <n>          Serve port (default 8000).",
  "  --kv-cache <gb>     KV-cache GB; raises the model's minimum if larger.",
  "  --gpu-util <f>      Override the computed --gpu-memory-utilization (0..1).",
  "  --cache-dir <path>  HF cache directory (default: $VLLM_HF_CACHE_DIR).",
  "  --hf-token <tok>    HuggingFace token for gated/private models (default: $VLLM_HF_TOKEN).",
  "  --id <id>           Instance id for container name / pidfile (default `dev`).",
  "  --force             Start even if the compatibility gate fails.",
  "  --json              Emit machine-readable JSON on stdout (progress/diagnostics stay on stderr).",
  "",
  "Across coupled nodes (run once per node, rank 0 serves):",
  "  --nnodes <n>        Number of nodes the model spans (default 1).",
  "  --node-rank <r>     This node's rank, 0 to n-1.",
  `  --master-port <n>   Rendezvous port on rank 0 (default ${DEFAULT_MASTER_PORT}).`,
].join("\n");

const { values } = parseArgs({
  options: {
    models: { type: "string" },
    model: { type: "string" },
    plan: { type: "boolean" },
    download: { type: "boolean" },
    start: { type: "boolean" },
    stop: { type: "boolean" },
    image: { type: "string" },
    "vllm-path": { type: "string" },
    port: { type: "string" },
    "kv-cache": { type: "string" },
    "gpu-util": { type: "string" },
    "cache-dir": { type: "string" },
    "hf-token": { type: "string" },
    id: { type: "string" },
    force: { type: "boolean" },
    json: { type: "boolean" },
    nnodes: { type: "string" },
    "node-rank": { type: "string" },
    "master-port": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

jsonMode = values.json ?? false;

type Verb = "plan" | "download" | "start" | "stop";
function resolveVerb(): Verb {
  const chosen = (["download", "start", "stop", "plan"] as const).filter((v) => values[v]);
  if (chosen.length > 1) die(`choose at most one verb; got: ${chosen.map((v) => `--${v}`).join(", ")}`);
  return chosen[0] ?? "plan";
}

const verb = resolveVerb();
const id = values.id ?? "dev";
const port = values.port ? Number(values.port) : DEFAULT_PORT;
if (!Number.isInteger(port) || port <= 0) die(`--port must be a positive integer, got "${values.port}"`);
const kvCacheOverride = values["kv-cache"] ? Number(values["kv-cache"]) : undefined;
if (kvCacheOverride !== undefined && (!Number.isFinite(kvCacheOverride) || kvCacheOverride < 0)) {
  die(`--kv-cache must be a non-negative number, got "${values["kv-cache"]}"`);
}
const gpuUtilOverride = values["gpu-util"] ? Number(values["gpu-util"]) : undefined;
if (gpuUtilOverride !== undefined && (!(gpuUtilOverride > 0) || gpuUtilOverride > 1)) {
  die(`--gpu-util must be in (0, 1], got "${values["gpu-util"]}"`);
}

const nodeCount = values.nnodes ? Number(values.nnodes) : 1;
if (!Number.isInteger(nodeCount) || nodeCount < 1) {
  die(`--nnodes must be a positive integer, got "${values.nnodes}"`);
}
const nodeRank = values["node-rank"] ? Number(values["node-rank"]) : 0;
if (!Number.isInteger(nodeRank) || nodeRank < 0 || nodeRank >= nodeCount) {
  die(`--node-rank must be between 0 and ${nodeCount - 1}, got "${values["node-rank"]}"`);
}
const masterPort = values["master-port"] ? Number(values["master-port"]) : DEFAULT_MASTER_PORT;
if (!Number.isInteger(masterPort) || masterPort <= 0) {
  die(`--master-port must be a positive integer, got "${values["master-port"]}"`);
}
if (nodeCount === 1 && (values["node-rank"] || values["master-port"])) {
  die("--node-rank and --master-port need --nnodes above 1");
}

const backend: "docker" | "bare" = values.image ? "docker" : "bare";
const bareVllmPath = backend === "bare" ? (values["vllm-path"] ?? Bun.which("vllm") ?? undefined) : undefined;

// config.ts validates at import time; seed placeholders so the daemon modules
// can be imported without a running tether.
process.env.TETHER_URL ??= "http://placeholder:4020";
process.env.TETHER_SECRET ??= "placeholder";
process.env.LOG_LEVEL ??= "fatal";
if (values.image) process.env.VLLM_DOCKER_IMAGE = values.image;
if (bareVllmPath) process.env.VLLM_PATH = bareVllmPath;
if (values["cache-dir"]) process.env.VLLM_HF_CACHE_DIR = values["cache-dir"];
if (values["hf-token"]) process.env.VLLM_HF_TOKEN = values["hf-token"];

const [
  { buildDockerRunArgs, buildSystemdServeArgv, couplingNetworkCreateArgs, ensureCouplingNetworks, ensureVllmNetwork, groupTensorParallelSize, pathCidr, SINGLE_NODE, VLLM_NETWORK },
  { launchConfig, loadingAllowanceGb, perCardSizing },
  { detectHardwareProfile },
  { detectVllmFeatures },
  { readHostDevices, unpinnedDevicesFor },
  { addressInUse, coupledPaths },
] = await Promise.all([
  import("../modules/model-installation/vllm-ops"),
  import("../modules/model-installation/vllm"),
  import("../modules/hardware-detect"),
  import("../modules/vllm-features"),
  import("../modules/model-installation/gpu-devices"),
  import("../modules/model-installation/coupling-network"),
]);

const modelFileSchema = z.object({ models: z.record(z.string(), z.any()) });

async function loadModelFile(path: string): Promise<{ models: Record<string, any> }> {
  const text = await Bun.file(path).text().catch(() => die(`could not read model file: ${path}`));
  let raw: unknown;
  try {
    raw = path.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text);
  } catch (err) {
    die(`model file is not valid ${path.endsWith(".json") ? "JSON" : "YAML"}: ${(err as Error).message}`);
  }
  const parsed = ModelFileSchema.safeParse(raw);
  if (!parsed.success) die(`model file failed validation:\n${z.prettifyError(parsed.error)}`);
  return modelFileSchema.parse(parsed.data);
}

/** Undefined if unprobeable. The docker probe uses --pull=never so it never triggers a
 * multi-GB image pull; an image not present locally simply reports as undetectable. */
async function detectVllmVersion(deviceArgs: string[]): Promise<string | undefined> {
  const run =
    backend === "docker"
      ? // `vllm --version` needs a visible GPU or it aborts -> version_unknown.
        () => $`docker run --rm --pull=never ${deviceArgs} --entrypoint ${process.env.VLLM_PATH || "vllm"} ${values.image} --version`.throws(false).text()
      : () => $`${bareVllmPath ?? "vllm"} --version`.throws(false).text();
  try {
    const out = await run();
    const match = out.match(/(\d+\.\d+\.\d+\S*)/)?.[1];
    return match;
  } catch {
    return undefined;
  }
}

function memberAddress(subnet: string, rank: number): string {
  // Rank r takes the r-th free address from the top, as the scheduler hands them out.
  const taken = new Set<string>();
  for (let earlier = 0; earlier < rank; earlier++) {
    taken.add(freeMemberAddress(subnet, taken)!);
  }
  return freeMemberAddress(subnet, taken)!;
}

async function resolveGroup(): Promise<NodeGroup> {
  if (nodeCount === 1) {
    return SINGLE_NODE;
  }
  const local = await coupledPaths();
  if (local.length === 0) {
    die("this node has no coupled RDMA port, `xinity stack doctor` shows why");
  }
  // Sorted, so every rank meets rank 0 on the same subnet whatever order its own ports list in.
  const paths = local
    .map((path) => ({ ...path, address: memberAddress(path.subnet, nodeRank) }))
    .sort((a, b) => a.subnet.localeCompare(b.subnet));
  return { kind: "member", size: nodeCount, rank: nodeRank, masterAddr: memberAddress(paths[0]!.subnet, 0), masterPort, paths };
}

function serveArgv(config: VllmInstanceConfig): string[] {
  if (backend !== "docker") return buildSystemdServeArgv(config);
  return buildDockerRunArgs(id, config, "preview");
}

const EGRESS_BLOCKED_SETUP = `docker network create -o com.docker.network.bridge.enable_ip_masquerade=false ${VLLM_NETWORK}  # once (egress-blocked)`;

const DOCKER_NETWORKS: { [Kind in NodeGroup["kind"]]: { note: string; setup: (group: Extract<NodeGroup, { kind: Kind }>) => string[] } } = {
  single: { note: "no egress: internet blocked, published port only", setup: () => [EGRESS_BLOCKED_SETUP] },
  member: {
    note: "no egress: the other members over the coupling, published port only",
    setup: (group) => [EGRESS_BLOCKED_SETUP, ...group.paths.map((path) => `docker ${quoteShellArgv(couplingNetworkCreateArgs(path))}  # once per coupled port`)],
  },
};

const dockerNetworksOf = (group: NodeGroup) => DOCKER_NETWORKS[group.kind] as { note: string; setup: (group: NodeGroup) => string[] };

const followLogsCommand = `docker logs -f vllm-${id}`;
const stopCommand = `docker stop vllm-${id} && docker rm vllm-${id}`;

const pidFile = join(tmpdir(), `xinity-run-model-${id}.pid`);

async function ensureDownloaded(resolved: ResolvedVllmModel): Promise<void> {
  const { downloadModel } = await import("../modules/model-installation/vllm-download");
  let lastPct = -1;
  await downloadModel(resolved.vllmProviderName, async (progress) => {
    const pct = Math.floor(progress * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      process.stderr.write(`\rDownloading ${resolved.vllmProviderName}: ${pct}%   `);
    }
  }, resolved.model.downloadFilter ?? []);
  process.stderr.write("\n");
  emit({ ok: true, event: "downloaded", model: resolved.vllmProviderName });
}

async function startServer(config: VllmInstanceConfig): Promise<never> {
  const argv = serveArgv(config);

  const memberPaths = config.group.kind === "member" ? config.group.paths : [];
  for (const { address } of memberPaths) {
    if (await addressInUse(address)) {
      die(`${address} is already in use on the coupling, so this member cannot take it`);
    }
  }

  // docker run -d returns once the container is created; print the follow/stop hints and exit.
  if (backend === "docker") {
    await ensureVllmNetwork();
    if (memberPaths.length > 0) {
      await ensureCouplingNetworks(memberPaths);
    }
    console.error(`Starting (docker, ${dockerNetworksOf(config.group).note}):\n  ${quoteShellArgv(argv)}\n`);
    const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code !== 0) process.exit(code);
    console.error(`\nStarted container "vllm-${id}". The model is still loading inside it.`);
    console.error(`Follow the load:  ${followLogsCommand}`);
    console.error(`Stop & remove:    ${stopCommand}`);
    emit({ ok: true, event: "started", backend, id, container: `vllm-${id}`, followLogsCommand, stopCommand });
    process.exit(0);
  }

  const memberAddresses = memberPaths.map((path) => ({ address: pathCidr(path), device: path.interface }));
  for (const { address, device } of memberAddresses) {
    await $`ip addr replace ${address} dev ${device}`;
  }

  console.error(`Starting (bare):\n  ${quoteShellArgv(argv)}\n`);
  const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  await Bun.write(pidFile, String(proc.pid));
  emit({ ok: true, event: "starting", backend, port, pid: proc.pid, argv });

  const cleanup = () => { try { proc.kill(); } catch { /* already gone */ } };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const code = await proc.exited;
  await $`rm -f ${pidFile}`.nothrow();
  for (const { address, device } of memberAddresses) {
    await $`ip addr del ${address} dev ${device}`.nothrow();
  }
  process.exit(code);
}

async function stopServer(): Promise<void> {
  if (backend === "docker") {
    await $`docker stop vllm-${id}`.nothrow();
    await $`docker rm vllm-${id}`.nothrow();
    console.error(`Stopped docker container vllm-${id}.`);
    emit({ ok: true, event: "stopped", backend, id });
    return;
  }
  const pidText = await Bun.file(pidFile).text().catch(() => null);
  if (!pidText) die(`no running instance found for --id ${id} (no pidfile at ${pidFile}).`, "not_running");
  const pid = Number(pidText.trim());
  let killed = true;
  try {
    process.kill(pid, "SIGTERM");
    console.error(`Sent SIGTERM to pid ${pid}.`);
  } catch {
    killed = false;
    console.error(`Process ${pid} was not running.`);
  }
  await $`rm -f ${pidFile}`.nothrow();
  emit({ ok: true, event: "stopped", backend, id, pid, killed });
}

/**
 * Reads against the GPUs just detected on this host, so it describes the card the model
 * would actually run on. An unlisted card yields nothing rather than a default-class guess.
 */
function describeSpeed(estimate: ReturnType<typeof estimateThroughput>): string {
  if (!estimate) {
    return "no estimate (no GPU detected)";
  }
  if (estimate.basis !== "known-gpu") {
    return "no estimate (this GPU is not in the speed table)";
  }
  const prefill = estimate.prefillTps === undefined
    ? "prompt unknown (entry states no weightBits)"
    : `~${Math.round(estimate.prefillTps)} tok/s prompt`;
  return `~${Math.round(estimate.decodeTps)} tok/s generate, ${prefill}`;
}

/**
 * Which limit the sweet spot came from, since each one calls for a different response:
 * more cache, a bigger card, or nothing at all. The cache limits are checked first so a
 * tie names the one an operator can act on.
 */
function bindingLimit(estimate: ConcurrencyEstimate): string {
  if (estimate.sweetSpot === estimate.workingSetConcurrency) {
    return "cache size";
  }
  if (estimate.sweetSpot === estimate.kvBandwidthKnee) {
    return "kv bandwidth";
  }
  return "compute";
}

function describeConcurrency(estimate: ConcurrencyEstimate | undefined, gpuCount: number): string {
  if (gpuCount === 0) {
    return "no estimate (no GPU detected)";
  }
  if (!estimate) {
    return "no estimate (entry states no kvBytesPerToken)";
  }
  if (estimate.basis !== "known-gpu") {
    return "no estimate (this GPU is not in the speed table)";
  }
  return `${estimate.sweetSpot} concurrent (${bindingLimit(estimate)}), `
    + `${Math.round(estimate.aggregateTps)} of ${Math.round(estimate.maxAggregateTps)} tok/s total`;
}

const GROUP_SUMMARIES: { [Kind in NodeGroup["kind"]]: (group: Extract<NodeGroup, { kind: Kind }>) => string } = {
  single: () => "this node only",
  member: (group) =>
    `rank ${group.rank} of ${group.size} (${group.rank === 0 ? "serves" : "headless"}), `
    + `rendezvous ${group.masterAddr}:${group.masterPort} over ${group.paths[0]!.interface}, RDMA over ${group.paths.map((path) => path.rdmaDevice).join(", ")}`,
};

const summarizeGroup = (group: NodeGroup) => (GROUP_SUMMARIES[group.kind] as (group: NodeGroup) => string)(group);

function printPlan(resolved: ResolvedVllmModel, profile: HardwareProfile, driver: VllmDriverState, config: VllmInstanceConfig, share: CardShare, charge: NodeCharge | undefined): void {
  const reason = checkVllmCompatibility(resolved, profile, driver, { requireKnownVersion: true });
  const speed = estimateThroughput(resolved.model, { gpus: profile.gpus });
  const concurrency = estimateConcurrency(resolved.model, { gpus: profile.gpus }, { kvCacheGb: resolved.kvCacheGb });

  if (jsonMode) {
    emit({
      ok: true,
      verb: "plan",
      model: { input: values.model, providerModel: resolved.vllmProviderName, type: resolved.modelType ?? "chat" },
      backend,
      image: backend === "docker" ? values.image : undefined,
      vllmBinary: backend === "bare" ? (bareVllmPath ?? null) : undefined,
      vllm: { available: driver.available, version: driver.version ?? null, minVersion: resolved.minVersion ?? null },
      machine: { gpus: profile.gpus, capacityGb: profile.detectedCapacityGb },
      group: config.group,
      sizing: {
        kvCacheGb: resolved.kvCacheGb,
        estCapacityGb: resolved.estCapacity,
        perCard: share,
        gpuGbPerCard: charge?.gpuGbPerCard ?? null,
        hostGb: charge?.hostGb ?? null,
        hostMemoryLimitBytes: config.hostMemoryLimitBytes ?? null,
        gpuMemoryUtilization: config.gpuMemoryUtilization ?? null,
      },
      speed: speed?.basis === "known-gpu"
        ? { decodeTps: speed.decodeTps, prefillTps: speed.prefillTps ?? null }
        : null,
      concurrency: concurrency?.basis === "known-gpu"
        ? {
            sweetSpot: concurrency.sweetSpot,
            limit: bindingLimit(concurrency),
            fullContextConcurrency: concurrency.fullContextConcurrency,
            workingSetConcurrency: concurrency.workingSetConcurrency,
            kvBandwidthKnee: concurrency.kvBandwidthKnee,
            computeKnee: concurrency.computeKnee ?? null,
            decodeTpsAtSweetSpot: concurrency.decodeTpsAtSweetSpot,
            aggregateTps: concurrency.aggregateTps,
            maxAggregateTps: concurrency.maxAggregateTps,
          }
        : null,
      gate: { ok: reason === null, reason: reason ?? null, message: reason ? describeIncompatibility(reason, resolved, profile, driver) : null },
      download: { filters: resolved.model.downloadFilter ?? [] },
      network: backend === "docker" ? { name: VLLM_NETWORK } : undefined,
      port,
      startCommand: serveArgv(config),
      followLogsCommand: backend === "docker" ? followLogsCommand : undefined,
      stopCommand: backend === "docker" ? stopCommand : undefined,
    });
    return;
  }

  const gpus = profile.gpus.map((g) => `${g.vendor} ${g.name}`).join(", ") || "none";

  console.log(`Model:    ${resolved.vllmProviderName}  (type=${resolved.modelType ?? "chat"})`);
  console.log(`Backend:  ${backend}${backend === "docker" ? ` (${values.image})  [${dockerNetworksOf(config.group).note}]` : ` (${bareVllmPath ?? "vllm not found on PATH"})`}`);
  console.log(`vLLM:     ${driver.available ? (driver.version ?? "version undetectable") : "not available"}${resolved.minVersion ? `  (model requires >= ${resolved.minVersion})` : ""}`);
  console.log(`Machine:  ${gpus}; ${profile.detectedCapacityGb}GB capacity`);
  console.log(`Group:    ${summarizeGroup(config.group)}`);
  console.log(`Sizing:   kvCache=${resolved.kvCacheGb}GB, estCapacity=${resolved.estCapacity}GB on this node, per card weights=${share.weightGb}GB kvCache=${share.kvCacheGb}GB, gpuUtil=${config.gpuMemoryUtilization ?? "n/a"}`);
  console.log(`Charge:   ${charge ? `${charge.gpuGbPerCard.toFixed(2)}GB per card, ${charge.hostGb.toFixed(2)}GB host, limit ${((config.hostMemoryLimitBytes ?? 0) / 1e9).toFixed(2)}GB` : "n/a"}`);
  console.log(`Speed:    ${describeSpeed(speed)}`);
  console.log(`Batch:    ${describeConcurrency(concurrency, profile.gpus.length)}`);
  console.log(`Gate:     ${reason ? `FAIL - ${describeIncompatibility(reason, resolved, profile, driver)}` : "ok"}`);
  console.log();
  console.log(`# Download (run: --download)`);
  console.log(`#   files filtered by: ${resolved.model.downloadFilter?.length ? resolved.model.downloadFilter.join(" ") : "(daemon defaults only)"}`);
  console.log();
  console.log(`# Start command`);
  if (backend === "docker") {
    for (const line of dockerNetworksOf(config.group).setup(config.group)) {
      console.log(line);
    }
  }
  console.log(quoteShellArgv(serveArgv(config)));
  if (backend === "docker") {
    console.log();
    console.log(`# Follow logs (the container starts detached)`);
    console.log(followLogsCommand);
  }
  console.log();
  console.log(`# Stop`);
  console.log(backend === "docker" ? stopCommand : `run-model --stop --id ${id}   (or Ctrl-C)`);
}

async function main(): Promise<void> {
  if (!values.models || !values.model) die("missing required flag(s). Run with --help for usage.");

  const parsed = await loadModelFile(values.models);
  const resolved = resolveVllmModel(parsed, values.model, { kvCacheGbOverride: kvCacheOverride });

  if (verb === "stop") {
    await stopServer();
    return;
  }

  const profile = await detectHardwareProfile();
  const devices = unpinnedDevicesFor(profile.gpus, await readHostDevices());
  const source: "docker" | "binary" = backend === "docker" ? "docker" : "binary";
  const [version, features] = await Promise.all([
    detectVllmVersion(devices.dockerArgs),
    detectVllmFeatures(source, { dockerImage: values.image, vllmPath: bareVllmPath }),
  ]);
  const driver: VllmDriverState = {
    available: backend === "docker" ? true : bareVllmPath !== undefined,
    version,
    features,
  };
  const group = await resolveGroup();
  const share = perCardSizing(
    { specifier: resolved.vllmProviderName, estCapacity: resolved.estCapacity, kvCacheCapacity: resolved.kvCacheGb },
    resolved.model.sizing,
    groupTensorParallelSize({ devices, group }),
  );
  const charge = chargeOnNode(resolved, profile.gpus, { cardsPerNode: devices.tensorParallelSize, nodes: nodeCount, node: nodeRank }, driver.version);
  const loadingGb = await loadingAllowanceGb(resolved.vllmProviderName, driver.version);
  const config = launchConfig({
    model: resolved,
    port,
    share,
    charge,
    maxNumSeqs: maxNumSeqs(resolved.model, profile.gpus, resolved.kvCacheGb),
    loadingGb,
    profile,
    devices,
    group,
    gpuMemoryUtilization: gpuUtilOverride,
  });
  // Every node in a group downloads the whole model but only holds its own cards' share of it.
  const gpuOnThisNode = (charge?.gpuGbPerCard ?? share.weightGb + share.kvCacheGb) * devices.tensorParallelSize;
  const onThisNode: ResolvedVllmModel = {
    ...resolved,
    estCapacity: chargedAgainstCards({ gpuGb: gpuOnThisNode, hostGb: charge?.hostGb ?? 0 }, sharesHostMemory(profile.gpus)),
  };

  if (verb === "plan") {
    printPlan(onThisNode, profile, driver, config, share, charge);
    return;
  }

  if (verb === "download") {
    await ensureDownloaded(resolved);
    console.error("Download complete.");
    return;
  }

  const reason = checkVllmCompatibility(onThisNode, profile, driver, { requireKnownVersion: true });
  if (reason && !values.force) {
    die(`${describeIncompatibility(reason, onThisNode, profile, driver)}\nUse --force to start anyway.`, reason);
  }
  if (reason) console.error(`warning: starting despite failed gate (${reason}) because --force was given.`);
  await ensureDownloaded(resolved);
  await startServer(config);
}

main().catch((err) => {
  if (err instanceof RunModelError) die(err.message, "resolution_error");
  die(err instanceof Error ? err.message : String(err), "error");
});
