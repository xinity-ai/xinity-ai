// Prints, without spawning anything, the vLLM command the daemon would build for a
// model against a hand-authored machine state. Reuses the daemon's real builders. See --help.

import { parseArgs } from "node:util";
import { z } from "zod";
import { maxNumSeqs, quoteShellArgv } from "common-env";
import { ModelFileSchema } from "common-env/model-catalog";
import { chargeOnNode, resolveVllmModel, RunModelError, type ResolvedVllmModel } from "./lib/vllm-run";
import type { VllmInstanceConfig } from "../modules/model-installation/vllm-ops";
import type { DetectedGpu } from "../modules/hardware-detect";

const StateSchema = z.object({
  backend: z.enum(["docker", "systemd"]),
  port: z.number().int().positive(),
  id: z.string().default("dev"),
  vllmPath: z.string().optional(),
  dockerImage: z.string().optional(),
  gpus: z.array(z.object({
    vendor: z.enum(["nvidia", "amd", "intel"]),
    name: z.string(),
    vramMb: z.number().int().nonnegative(),
  })).default([]),
  freeMemoryMb: z.number().int().nonnegative().optional(),
  systemRamMb: z.number().int().nonnegative().default(0),
});
type State = z.infer<typeof StateSchema>;

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function loadYaml<T>(path: string, schema: z.ZodType<T>, label: string): Promise<T> {
  const text = await Bun.file(path).text().catch(() => die(`could not read ${label} file: ${path}`));
  let raw: unknown;
  try { raw = Bun.YAML.parse(text); } catch (err) {
    die(`${label} is not valid YAML: ${(err as Error).message}`);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    die(`${label} failed validation:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

const HELP = [
  "Print the vLLM command the daemon would build for a model + state.",
  "",
  "Required flags:",
  "  --models <path.yaml>  Infoserver model YAML (same shape as the models/ entries)",
  "  --model  <name>       Public specifier (key in models:) or engineSpecifier value",
  "  --state  <path.yaml>  Hardware + backend state. See src/scripts/state.example.yaml",
  "",
  "State file fields (target-machine state):",
  "  backend, port, id, gpus[], freeMemoryMb, systemRamMb",
  "  vllmPath              binary path baked into systemd argv (systemd backend)",
  "  dockerImage           image used in `docker run` argv (docker backend)",
].join("\n");

const { values } = parseArgs({
  options: {
    models: { type: "string" },
    model: { type: "string" },
    state: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (!values.models || !values.model || !values.state) {
  die("missing required flag(s). Run with --help for usage.");
}

const state = await loadYaml(values.state, StateSchema, "state");

if (state.backend === "docker" && !state.dockerImage) {
  die("state.dockerImage is required for backend=docker.");
}

// config.ts validates at import time; seed placeholders so the daemon modules
// can be imported without a running tether.
process.env.TETHER_URL ??= "http://placeholder:4020";
process.env.TETHER_SECRET ??= "placeholder";
process.env.LOG_LEVEL ??= "fatal";
if (state.vllmPath) process.env.VLLM_PATH = state.vllmPath;
if (state.dockerImage) process.env.VLLM_DOCKER_IMAGE = state.dockerImage;

const [
  { buildDockerRunArgs, buildSystemdEnvFile, buildSystemdDropIn, buildSystemdServeArgv, SINGLE_NODE },
  { computeGpuUtilization, buildVllmExtraArgs, hostMemoryLimitBytes },
  { buildHardwareProfile },
  { NO_HOST_DEVICES, unpinnedDevicesFor },
] = await Promise.all([
  import("../modules/model-installation/vllm-ops"),
  import("../modules/model-installation/vllm"),
  import("../modules/hardware-detect"),
  import("../modules/model-installation/gpu-devices"),
]);

function buildVllmInstanceConfig(resolved: ResolvedVllmModel, state: State): VllmInstanceConfig {
  const profile = buildHardwareProfile(state.gpus as DetectedGpu[], state.systemRamMb);
  const devices = unpinnedDevicesFor(profile.gpus, NO_HOST_DEVICES);
  const charge = chargeOnNode(resolved, profile.gpus, { cardsPerNode: devices.tensorParallelSize, nodes: 1, node: 0 }, undefined);
  const gpuMemoryUtilization = charge && computeGpuUtilization({ specifier: resolved.vllmProviderName, gpuGb: charge.gpuGbPerCard }, profile);

  return {
    model: resolved.vllmProviderName,
    port: state.port,
    kvCacheBytes: `${resolved.kvCacheGb}g`,
    trustRemoteCode: resolved.trustRemoteCode,
    gpuMemoryUtilization,
    extraArgs: buildVllmExtraArgs(
      resolved.modelType,
      resolved.hasToolsTag,
      resolved.args,
      maxNumSeqs(resolved.model, profile.gpus, resolved.kvCacheGb),
    ),
    devices,
    group: SINGLE_NODE,
    hostMemoryLimitBytes: charge && hostMemoryLimitBytes(charge.hostGb),
  };
}

const parsedModels = await loadYaml(values.models, ModelFileSchema, "model");
let resolved: ResolvedVllmModel;
try {
  resolved = resolveVllmModel(parsedModels, values.model);
} catch (err) {
  if (err instanceof RunModelError) die(err.message);
  throw err;
}
const config = buildVllmInstanceConfig(resolved, state);

if (state.backend === "docker") {
  const argv = buildDockerRunArgs(state.id, config, "preview");
  console.log(quoteShellArgv(argv));
} else {
  console.log(`# /etc/vllm/${state.id}.env`);
  process.stdout.write(buildSystemdEnvFile(config));
  console.log();
  console.log(`# vllm-driver@${state.id}.service.d/serve.conf`);
  process.stdout.write(buildSystemdDropIn(config));
  console.log();
  console.log(`# Equivalent vllm serve command`);
  console.log(quoteShellArgv(buildSystemdServeArgv(config)));
}
