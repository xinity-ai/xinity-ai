// Prints the vLLM command the daemon would build for a model + state, without
// spawning anything. Reuses the daemon's real command builders.
//
// Usage:
//   bun run print-vllm-command -- \
//     --models <path/to/models.yaml> \
//     --model  <public-specifier-or-vllm-provider-name> \
//     --state  <path/to/state.yaml>

import { parseArgs } from "node:util";
import { z } from "zod";
import {
  ModelFileDefinitionSchema,
  resolveDriverForProviderModel,
  resolveTagsForDriver,
  resolveArgsForDriver,
  type Model,
} from "xinity-infoserver";
// Daemon modules are loaded via dynamic import below, after process.env is
// seeded; static imports would parse env.ts before our overrides land.
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
  "  --models <path.yaml>  Infoserver model YAML (same shape as xinity-infoserver/models.yaml)",
  "  --model  <name>       Public specifier (key in models:) or providers.vllm value",
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

// Seed process.env before the daemon modules import: env.ts validates at load
// and the builders read env.* directly. DB_CONNECTION_URL satisfies the
// schema (no DB is opened); LOG_LEVEL keeps the logger off stdout.
process.env.DB_CONNECTION_URL ??= "postgres://placeholder";
process.env.LOG_LEVEL ??= "fatal";
if (state.vllmPath) process.env.VLLM_PATH = state.vllmPath;
if (state.dockerImage) process.env.VLLM_DOCKER_IMAGE = state.dockerImage;

const [
  { buildDockerRunArgs, buildSystemdEnvFile, buildSystemdServeArgv },
  { computeGpuUtilization },
  { buildHardwareProfile },
] = await Promise.all([
  import("../modules/model-installation/vllm-ops"),
  import("../modules/model-installation/vllm"),
  import("../modules/hardware-detect"),
]);

/** Accepts either a public specifier (key in `models:`) or a `providers.vllm` value, returning the HF-style provider name the daemon uses downstream. */
function findModel(
  parsed: { models: Record<string, Model> },
  name: string,
): { vllmProviderName: string; model: Model } {
  const direct = parsed.models[name];
  if (direct) {
    if (!direct.providers.vllm) {
      die(`model "${name}" has no providers.vllm entry; cannot build a vllm command for it.`);
    }
    return { vllmProviderName: direct.providers.vllm, model: direct };
  }
  for (const model of Object.values(parsed.models)) {
    if (model.providers.vllm === name) return { vllmProviderName: name, model };
  }
  const known = Object.keys(parsed.models).join(", ");
  die(`model "${name}" not found in model file (looked at public specifiers and providers.vllm). Known: ${known}`);
}

function quoteShellArg(s: string): string {
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function quoteShellArgv(argv: string[]): string {
  return argv.map(quoteShellArg).join(" ");
}

function buildVllmInstanceConfig(
  modelName: string,
  model: Model,
  state: State,
): VllmInstanceConfig {
  const driver = resolveDriverForProviderModel(model, modelName);
  if (driver !== "vllm") {
    die(`model "${modelName}" does not have a vllm provider entry (resolved driver: ${driver ?? "none"}).`);
  }

  const tags = resolveTagsForDriver(model, "vllm");
  const trustRemoteCode = tags.includes("custom_code");
  const hasToolsTag = tags.includes("tools");
  const providerArgs = resolveArgsForDriver(model, "vllm");
  const modelType = model.type;

  // estCapacity formula mirrors orchestration.mod.ts; kvCache uses minKvCache.
  const kvCacheGb = model.minKvCache;
  const estCapacity = model.weight + kvCacheGb;

  const profile = buildHardwareProfile(state.gpus as DetectedGpu[], state.systemRamMb);
  const gpuMemoryUtilization = computeGpuUtilization(
    { model: modelName, estCapacity },
    profile,
    state.freeMemoryMb ?? null,
  );

  return {
    model: modelName,
    port: state.port,
    kvCacheBytes: `${kvCacheGb}g`,
    trustRemoteCode,
    gpuMemoryUtilization,
    extraArgs: [
      ...(modelType === "embedding" || modelType === "rerank" ? ["--runner", "pooling"] : []),
      ...(hasToolsTag ? ["--enable-auto-tool-choice"] : []),
      ...providerArgs,
    ],
  };
}

const parsedModels = await loadYaml(values.models, ModelFileDefinitionSchema, "model");
const { vllmProviderName, model } = findModel(parsedModels, values.model);
const config = buildVllmInstanceConfig(vllmProviderName, model, state);

if (state.backend === "docker") {
  const argv = buildDockerRunArgs(state.id, config, "preview");
  console.log(quoteShellArgv(argv));
} else {
  const envContent = buildSystemdEnvFile(config);
  const argv = buildSystemdServeArgv(config);

  console.log(`# /etc/vllm/${state.id}.env`);
  process.stdout.write(envContent);
  console.log();
  console.log(`# Equivalent vllm serve command (synthesized from the .service template)`);
  console.log(quoteShellArgv(argv));
}
