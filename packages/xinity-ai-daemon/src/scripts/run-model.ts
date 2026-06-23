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
import { quoteShellArgv } from "common-env";
import { ModelFileDefinitionSchema, normalizePep440 } from "xinity-infoserver";
import {
  resolveVllmModel,
  checkVllmCompatibility,
  describeIncompatibility,
  RunModelError,
  type ResolvedVllmModel,
  type VllmDriverState,
} from "./lib/vllm-run";
import type { VllmInstanceConfig } from "../modules/model-installation/vllm-ops";
import type { HardwareProfile } from "../modules/hardware-detect";

const DEFAULT_PORT = 8000;

let jsonMode = false;

function die(msg: string, code?: string): never {
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, error: msg, ...(code ? { code } : {}) }));
  } else {
    console.error(`error: ${msg}`);
  }
  process.exit(1);
}

/** Prints a structured record on stdout. A no-op outside --json mode. */
function emit(record: Record<string, unknown>): void {
  if (jsonMode) console.log(JSON.stringify(record));
}

const HELP = [
  "Resolve, gate, download and run a vLLM model on this machine.",
  "",
  "Required:",
  "  --models <file>     Model file (YAML or JSON, xinity-infoserver model shape)",
  "  --model  <name>     Public specifier (key in models:) or a providers.vllm value",
  "",
  "Verb (default --plan):",
  "  --plan              Print the plan (gate result, serve command, stop hint). No side effects.",
  "  --download          Resolve and download the model files into the HF cache.",
  "  --start             Gate, ensure files are downloaded, then start the server (attached).",
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
  "  --no-egress         (docker) Cut the container off from the internet, keeping only the",
  "                      published port reachable. Weights are pre-downloaded on the host first.",
  "  --force             Start even if the compatibility gate fails.",
  "  --json              Emit machine-readable JSON on stdout (progress/diagnostics stay on stderr).",
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
    "no-egress": { type: "boolean" },
    force: { type: "boolean" },
    json: { type: "boolean" },
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

const backend: "docker" | "bare" = values.image ? "docker" : "bare";
const bareVllmPath = backend === "bare" ? (values["vllm-path"] ?? Bun.which("vllm") ?? undefined) : undefined;

const noEgress = values["no-egress"] ?? false;
if (noEgress && backend === "bare") {
  die("--no-egress requires the docker backend; supply --image.");
}
/** Bridge with IP masquerade off: published ports keep working (DNAT), but the
 * container has no SNAT and so cannot reach the internet. */
const ISOLATED_NETWORK = "xinity-vllm-noegress";

// The daemon modules read env.* at import, so seed it first. The placeholder DB url
// satisfies the schema without opening a connection; LOG_LEVEL keeps the logger quiet.
process.env.DB_CONNECTION_URL ??= "postgres://placeholder";
process.env.LOG_LEVEL ??= "fatal";
if (values.image) process.env.VLLM_DOCKER_IMAGE = values.image;
if (bareVllmPath) process.env.VLLM_PATH = bareVllmPath;
if (values["cache-dir"]) process.env.VLLM_HF_CACHE_DIR = values["cache-dir"];
if (values["hf-token"]) process.env.VLLM_HF_TOKEN = values["hf-token"];

const [
  { buildDockerRunArgs, buildSystemdServeArgv },
  { computeGpuUtilization, buildVllmExtraArgs },
  { detectHardwareProfile },
] = await Promise.all([
  import("../modules/model-installation/vllm-ops"),
  import("../modules/model-installation/vllm"),
  import("../modules/hardware-detect"),
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
  const parsed = ModelFileDefinitionSchema.safeParse(raw);
  if (!parsed.success) die(`model file failed validation:\n${z.prettifyError(parsed.error)}`);
  return modelFileSchema.parse(parsed.data);
}

/** Undefined if unprobeable. The docker probe uses --pull=never so it never triggers a
 * multi-GB image pull; an image not present locally simply reports as undetectable. */
async function detectVllmVersion(): Promise<string | undefined> {
  const run =
    backend === "docker"
      ? () => $`docker run --rm --pull=never --entrypoint vllm ${values.image} --version`.throws(false).text()
      : () => $`${bareVllmPath ?? "vllm"} --version`.throws(false).text();
  try {
    const out = await run();
    const match = out.match(/(\d+\.\d+\.\d+\S*)/)?.[1];
    return match ? normalizePep440(match) : undefined;
  } catch {
    return undefined;
  }
}

function buildConfig(resolved: ResolvedVllmModel, profile: HardwareProfile): VllmInstanceConfig {
  const gpuMemoryUtilization =
    gpuUtilOverride ?? computeGpuUtilization({ model: resolved.vllmProviderName, estCapacity: resolved.estCapacity }, profile);
  return {
    model: resolved.vllmProviderName,
    port,
    kvCacheBytes: `${resolved.kvCacheGb}g`,
    trustRemoteCode: resolved.trustRemoteCode,
    gpuMemoryUtilization,
    extraArgs: buildVllmExtraArgs(resolved.modelType, resolved.hasToolsTag, resolved.providerArgs),
  };
}

function serveArgv(config: VllmInstanceConfig): string[] {
  if (backend !== "docker") return buildSystemdServeArgv(config);
  const dockerOptions = noEgress
    ? { network: ISOLATED_NETWORK, extraEnv: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } }
    : {};
  return buildDockerRunArgs(id, config, "preview", dockerOptions);
}

async function ensureIsolatedNetwork(): Promise<void> {
  const present = await $`docker network inspect ${ISOLATED_NETWORK}`.quiet().nothrow();
  if (present.exitCode === 0) return;
  await $`docker network create -o com.docker.network.bridge.enable_ip_masquerade=false ${ISOLATED_NETWORK}`.quiet();
  console.error(`Created egress-blocking docker network "${ISOLATED_NETWORK}".`);
}

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
  if (backend === "docker" && noEgress) await ensureIsolatedNetwork();
  const argv = serveArgv(config);
  console.error(`Starting (${backend}${noEgress ? ", no egress" : ""}):\n  ${quoteShellArgv(argv)}\n`);
  const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });

  if (backend === "bare") await Bun.write(pidFile, String(proc.pid));
  emit({ ok: true, event: "starting", backend, port, pid: proc.pid, noEgress, argv });
  const cleanup = () => { try { proc.kill(); } catch { /* already gone */ } };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const code = await proc.exited;
  if (backend === "bare") await $`rm -f ${pidFile}`.nothrow();
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

function printPlan(resolved: ResolvedVllmModel, profile: HardwareProfile, driver: VllmDriverState, config: VllmInstanceConfig): void {
  const reason = checkVllmCompatibility(resolved, profile, driver, { requireKnownVersion: true });

  if (jsonMode) {
    emit({
      ok: true,
      verb: "plan",
      model: { input: values.model, providerModel: resolved.vllmProviderName, type: resolved.modelType ?? "chat" },
      backend,
      image: backend === "docker" ? values.image : undefined,
      vllmBinary: backend === "bare" ? (bareVllmPath ?? null) : undefined,
      vllm: { available: driver.available, version: driver.version ?? null, minVersion: resolved.minVersion ?? null },
      noEgress,
      machine: { gpus: profile.gpus, capacityGb: profile.detectedCapacityGb },
      sizing: { kvCacheGb: resolved.kvCacheGb, estCapacityGb: resolved.estCapacity, gpuMemoryUtilization: config.gpuMemoryUtilization ?? null },
      gate: { ok: reason === null, reason: reason ?? null, message: reason ? describeIncompatibility(reason, resolved, profile, driver) : null },
      download: { filters: resolved.model.downloadFilter ?? [] },
      network: backend === "docker" && noEgress ? { name: ISOLATED_NETWORK } : undefined,
      port,
      startCommand: serveArgv(config),
    });
    return;
  }

  const gpus = profile.gpus.map((g) => `${g.vendor} ${g.name}`).join(", ") || "none";

  console.log(`Model:    ${resolved.vllmProviderName}  (type=${resolved.modelType ?? "chat"})`);
  console.log(`Backend:  ${backend}${backend === "docker" ? ` (${values.image})` : ` (${bareVllmPath ?? "vllm not found on PATH"})`}${noEgress ? "  [no egress: internet blocked, published port only]" : ""}`);
  console.log(`vLLM:     ${driver.available ? (driver.version ?? "version undetectable") : "not available"}${resolved.minVersion ? `  (model requires >= ${resolved.minVersion})` : ""}`);
  console.log(`Machine:  ${gpus}; ${profile.detectedCapacityGb}GB capacity`);
  console.log(`Sizing:   kvCache=${resolved.kvCacheGb}GB, estCapacity=${resolved.estCapacity}GB, gpuUtil=${config.gpuMemoryUtilization ?? "n/a"}`);
  console.log(`Gate:     ${reason ? `FAIL - ${describeIncompatibility(reason, resolved, profile, driver)}` : "ok"}`);
  console.log();
  console.log(`# Download (run: --download)`);
  console.log(`#   files filtered by: ${resolved.model.downloadFilter?.length ? resolved.model.downloadFilter.join(" ") : "(daemon defaults only)"}`);
  console.log();
  console.log(`# Start command`);
  if (backend === "docker" && noEgress) {
    console.log(`docker network create -o com.docker.network.bridge.enable_ip_masquerade=false ${ISOLATED_NETWORK}  # once`);
  }
  console.log(quoteShellArgv(serveArgv(config)));
  console.log();
  console.log(`# Stop`);
  console.log(backend === "docker" ? `docker stop vllm-${id} && docker rm vllm-${id}` : `run-model --stop --id ${id}   (or Ctrl-C)`);
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
  const driver: VllmDriverState = {
    available: backend === "docker" ? true : bareVllmPath !== undefined,
    version: await detectVllmVersion(),
  };
  const config = buildConfig(resolved, profile);

  if (verb === "plan") {
    printPlan(resolved, profile, driver, config);
    return;
  }

  if (verb === "download") {
    await ensureDownloaded(resolved);
    console.error("Download complete.");
    return;
  }

  const reason = checkVllmCompatibility(resolved, profile, driver, { requireKnownVersion: true });
  if (reason && !values.force) {
    die(`${describeIncompatibility(reason, resolved, profile, driver)}\nUse --force to start anyway.`, reason);
  }
  if (reason) console.error(`warning: starting despite failed gate (${reason}) because --force was given.`);
  await ensureDownloaded(resolved);
  await startServer(config);
}

main().catch((err) => {
  if (err instanceof RunModelError) die(err.message, "resolution_error");
  die(err instanceof Error ? err.message : String(err), "error");
});
