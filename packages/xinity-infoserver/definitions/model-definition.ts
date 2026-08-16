import { z } from "zod";
import { LicenseSchema } from "./licenses";
import {
  BLOCKED_REQUEST_PARAM_PREFIXES,
  EngineEnum,
  GpuVendorEnum,
  ModelDate,
  ModelTypeEnum,
  RequestParamTypeEnum,
  TagEnum,
  flatStringArray,
  hasBlockedRequestParam,
  isKnownEngine,
  isKnownGpuVendor,
  isKnownModelType,
  relayedPlatforms,
  relayedTags,
  stripBlockedVllmArgs,
} from "./model-primitives";

const KV_CACHE_DESCRIPTION =
  "Minimum KV-cache allocation in GB. " +
  "Should be precomputed from the model's config.json (if available) as roughly: " +
  "2 * num_hidden_layers * num_key_value_heads * head_dim * dtype_bytes * total_tokens, " +
  "where total_tokens is chosen based on desired concurrent capacity.";

const DOWNLOAD_FILTER_DESCRIPTION =
  "Gitignore-style glob patterns appended to the daemon's default HuggingFace download filter. " +
  "Patterns starting with `!` re-include, and the last matching rule wins. " +
  "Arrays are deeply flattened to support YAML anchors. " +
  "Example: [\"*.gguf\", \"!consolidated.safetensors\"]";

// ── Current format ─────────────────────────────────────────────────────

export const ModelSizing = z.looseObject({
  weightMib: z.number().positive().describe("VRAM consumed by this variant's weights, in MiB. Deliberately not constrained to whole MiB: an authored figure carries margin for loader overhead and engine-version variance, and rounding it would read as exact"),
  activeWeightMib: z.number().positive().optional().describe("Weights read per token by a mixture-of-experts variant, in MiB. Absent means dense, where every weight participates. Speed scales with this figure, while capacity still needs the full weight"),
  weightBits: z.number().positive().max(32).optional().describe("Nominal bits per stored parameter, e.g. 16 for fp16 or 4 for AWQ. Never an exact average: every method leaves parts of the network wider than its headline width, commonly attention projections, embeddings and norms. Dividing weightMib by it yields a parameter count good enough to estimate throughput from, and good for nothing that needs the real one"),
  minKvCacheMib: z.number().positive().describe(KV_CACHE_DESCRIPTION),
  kvBytesPerToken: z.number().int().positive().optional().describe("KV cache one token of context consumes, in bytes, i.e. 2 * num_hidden_layers * num_key_value_heads * head_dim * dtype_bytes. How many requests a deployment can serve at once follows from this and the cache it was given, so it is the figure concurrency is computed from"),
  maxContextLength: z.number().int().positive().describe("Maximum supported context window in tokens"),
  attentionWindow: z.number().int().positive().optional().describe("Sliding-window attention span in tokens, for models that have one. KV per request stops growing past this point, so a windowed model needs far less cache at long context than kvBytesPerToken alone suggests"),
}).refine(
  sizing => sizing.activeWeightMib === undefined || sizing.activeWeightMib <= sizing.weightMib,
  { message: "activeWeightMib must not exceed weightMib", path: ["activeWeightMib"] },
);

export type ModelSizingFields = z.infer<typeof ModelSizing>;

const MIB_PER_GB = 1024;

/** Scheduling, the stored capacities and the vLLM arguments still count in GB. Delete once they count in MiB. */
export function mibToGb(mib: number): number {
  return mib / MIB_PER_GB;
}

export const ModelFields = z.looseObject({
  name: z.string().describe("Display name of the model. Intended to be easily human readable"),
  description: z.string().describe("Multi-paragraph description: purpose, strengths, limitations. Shown when choosing between models, so a one-line label is not enough"),
  url: z.url().describe("External documentation url, for curious users that want to know more"),
  license: LicenseSchema.describe("License terms, as a well-known identifier or a full object. Governs what types of usage are permissible, if not all"),

  createdAt: ModelDate.describe("Date the model was published by its creator, as YYYY-MM-DD. Recency says a lot about capability, so it is shown wherever models are compared"),
  registeredAt: ModelDate.describe("Date this entry was added to the catalog, as YYYY-MM-DD. Entries added recently are flagged as new in the dashboard"),

  engine: EngineEnum.describe("Inference engine this entry runs on"),
  engineSpecifier: z.string().describe("Identifier the engine itself uses. A HuggingFace model id for vLLM, a tag for Ollama"),

  sizing: ModelSizing.describe("What this variant costs to run: how much VRAM it occupies, how much cache a token of context needs, and how far its context reaches"),

  type: ModelTypeEnum.default("chat").describe("Usage type, which determines API compatibility"),
  family: z.string().default("unknown").describe("Family of the model. May be unknown"),
  variantOf: z.string().optional().describe("Specifier of the standard variant of this model, when this entry is a variant of it. The UI presents the group together while each variant stays separately deployable and keeps its own license, description and capacity. A variant may not itself have variants"),
  tags: z.array(TagEnum).default([]).describe("Capabilities this variant supports: tools, vision, custom_code"),
  isCustom: z.boolean().default(false).describe("Set for fine-tuned models"),

  unlisted: z.boolean().default(false).describe("Keeps the entry out of the model picker without making it unusable. Deployments referencing it keep working, and a user can still reach it deliberately"),
  unlistedReason: z.string().optional().describe("Shown to anyone who unhides the entry. Leave unset when the model is simply old, and use it when the reason changes what a user should do"),

  engineArgs: flatStringArray.optional().describe("Extra CLI arguments appended to the engine's command line. Arrays are deeply flattened to support YAML anchors"),
  requestParams: z.record(z.string(), RequestParamTypeEnum).optional().describe("Allowlist of extra request-level parameters the gateway may forward, as dot-notation paths mapped to primitive types. All are optional at request time"),
  minEngineVersion: z.string().optional().describe("Minimum engine version required (semver). Older nodes are excluded from scheduling"),
  platforms: z.array(GpuVendorEnum).optional().describe("GPU vendor requirement. Absent means any platform"),

  minXinityVersion: z.string().optional().describe("Minimum xinity-ai version required to use this entry. Older clients skip entries they are too old for"),
  downloadFilter: flatStringArray.optional().describe(DOWNLOAD_FILTER_DESCRIPTION),
  custom: z.looseObject({
    baseModel: z.string(),
    extraFacts: z.record(z.string(), z.unknown()),
  }).optional().describe("Provenance for fine tuned custom models"),
});

/** For catalogs written elsewhere. Local files keep ModelFields, where an unknown value is a typo. */
export const RelayedModelFields = ModelFields.extend({
  tags: relayedTags.default([]),
  platforms: relayedPlatforms.optional(),
});

function withModelRules<T extends typeof ModelFields | typeof RelayedModelFields>(fields: T) {
  return fields
    .refine(
      model => !model.requestParams || !hasBlockedRequestParam(Object.keys(model.requestParams)),
      { message: "requestParams must not contain blocked prefixes", path: ["requestParams"] },
    )
    .transform(model => (
      model.engine === "vllm" && model.engineArgs
        ? { ...model, engineArgs: stripBlockedVllmArgs(model.engineArgs) }
        : model
    ));
}

export const ModelSchema = withModelRules(ModelFields);
export const RelayedModelSchema = withModelRules(RelayedModelFields);

export type Model = z.infer<typeof ModelSchema>;
export type ModelWithSpecifier = Model & { publicSpecifier: string; _source: string };

/** Checked before parsing, so these entries are counted as skipped rather than reported as errors. */
export function unsupportedVocabulary(entry: unknown): string | undefined {
  const { engine, type, platforms } = (entry ?? {}) as { engine?: unknown; type?: unknown; platforms?: unknown };

  if (engine !== undefined && !isKnownEngine(engine)) {
    return `unsupported engine: ${String(engine)}`;
  }
  if (type !== undefined && !isKnownModelType(type)) {
    return `unsupported model type: ${String(type)}`;
  }
  if (Array.isArray(platforms) && platforms.length > 0 && !platforms.some(isKnownGpuVendor)) {
    return `no recognised GPU vendor in platforms: ${platforms.join(", ")}`;
  }
  return undefined;
}

const BYTES_PER_MIB = 1024 * 1024;

/** Wide enough that an empirically confirmed floor and its overhead still pass. A factor beyond it
 * means the arithmetic itself is wrong, e.g. K and V counted once or the cache dtype misread. */
const KV_MISMATCH_FACTOR = 2;

export type KvCacheMismatch = { minKvCacheMib: number; impliedMib: number; ratio: number };

export function kvCacheMismatch(sizing: ModelSizingFields): KvCacheMismatch | undefined {
  if (sizing.kvBytesPerToken === undefined) {
    return undefined;
  }

  const cachedTokens = Math.min(sizing.maxContextLength, sizing.attentionWindow ?? Infinity);
  const impliedMib = (sizing.kvBytesPerToken * cachedTokens) / BYTES_PER_MIB;
  const ratio = sizing.minKvCacheMib / impliedMib;
  if (ratio >= 1 / KV_MISMATCH_FACTOR && ratio <= KV_MISMATCH_FACTOR) {
    return undefined;
  }

  return {
    minKvCacheMib: sizing.minKvCacheMib,
    impliedMib: Number(impliedMib.toFixed(2)),
    ratio: Number(ratio.toFixed(2)),
  };
}

export const ModelFileSchema = z.object({
  includes: z.url().array().optional().describe("Additional model sources to fetch and merge. Each must use this same format"),
  models: z.record(
    z.string().describe("Public model specifier. Unique, and carries the engine, e.g. gemma-4-27b-vllm"),
    ModelSchema,
  ),
});

export const RelayedModelFileSchema = z.object({
  includes: z.url().array().optional(),
  models: z.record(z.string(), z.unknown()),
});

export function createModelJsonSchema() {
  return ModelFileSchema.toJSONSchema({
    cycles: "ref",
    io: "input",
  });
}

// Deprecated v1 format, removed soon
//
// A single entry could claim several engines, which is why most of the schema
// below is per-provider maps, and why weight and minKvCache are single-valued
// even though they differ per engine. Kept only so deployments predating the
// current format keep resolving their stored specifiers.

export const ProviderEnum = EngineEnum;
export type Provider = z.infer<typeof ProviderEnum>;

const vllmArgs = flatStringArray.transform(stripBlockedVllmArgs);

export const LegacyModelSchema = z.looseObject({
  name: z.string().describe("Display name of the model. Intended to be easily human readable"),
  description: z.string().describe("Brief description of the model and its unique properties"),
  weight: z.number().describe("VRAM consumed by the model weights, in GB"),
  minKvCache: z.number().describe(KV_CACHE_DESCRIPTION),
  url: z.url().describe("External documentation url, for curious users that want to know more"),
  type: ModelTypeEnum.default("chat").optional().describe("Usage type of the model in question"),
  family: z.string().default("unknown").optional().describe("Family of the model. May be unknown"),
  tags: z.array(TagEnum).default([]).optional().describe("Default tags, used when providerTags is absent for a given driver. Also the searchable superset"),
  isCustom: z.boolean().default(false).optional(),
  providerTags: z.object({
    vllm: z.array(TagEnum).optional(),
    ollama: z.array(TagEnum).optional(),
  }).optional().describe("Per-driver tag overrides. When present for a driver, replaces model-level tags for that driver"),
  providerArgs: z.object({
    vllm: vllmArgs.optional(),
    ollama: flatStringArray.optional(),
  }).optional().describe("Per-driver extra CLI arguments appended to the server command line. Arrays are deeply flattened to support YAML anchors"),
  requestParams: z.object({
    vllm: z.record(z.string(), RequestParamTypeEnum).optional(),
    ollama: z.record(z.string(), RequestParamTypeEnum).optional(),
  }).refine(
    (obj) => !Object.values(obj).some(
      driverParams => driverParams && hasBlockedRequestParam(Object.keys(driverParams)),
    ),
    { message: `requestParams must not contain blocked prefixes: ${BLOCKED_REQUEST_PARAM_PREFIXES.join(", ")}` },
  ).optional().describe("Per-driver allowlist of extra request-level parameters that the gateway may forward. Dot-notation paths mapped to primitive types (boolean, number, string). All are optional at request time"),
  providers: z.object({
    vllm: z.string().describe("vLLM model specifier").optional(),
    ollama: z.string().describe("Ollama model specifier").optional(),
  }).refine(obj => Object.values(obj).some(v => v !== undefined), { message: "At least one provider must be specified" })
    .describe("Map from supported provider names to the provider-specific model specifier"),
  providerMinVersions: z.object({
    vllm: z.string().optional(),
    ollama: z.string().optional(),
  }).optional().describe("Per-driver minimum version requirements (semver). Nodes with older driver versions are excluded from scheduling"),
  providerPlatforms: z.object({
    vllm: z.array(GpuVendorEnum).optional(),
    ollama: z.array(GpuVendorEnum).optional(),
  }).optional().describe("Per-driver GPU platform requirements. Only nodes with a matching GPU vendor can serve. Absent = any platform"),
  entryVersion: z.string().optional().describe("Version of xinity-ai this model was introduced in"),
  maxContextLength: z.number().int().positive().default(131072).describe("Maximum supported context window in tokens."),
  downloadFilter: flatStringArray.optional().describe(DOWNLOAD_FILTER_DESCRIPTION),
  custom: z.looseObject({
    baseModel: z.string(),
    extraFacts: z.record(z.string(), z.unknown())
  }).optional().describe("Info for fine tuned custom models"),
});
export type LegacyModel = z.infer<typeof LegacyModelSchema>;
export type LegacyModelWithSpecifier = LegacyModel & { publicSpecifier: string; _source: string };

export const LegacyModelFileSchema = z.object({
  includes: z.url().array().describe([
    "Include instruction. Will result in fetch attempts for additional model sources.",
    "Global uniqueness of model identifiers persists"
  ].join("\n")).optional(),
  models: z.record(
    z.string().describe("Public model specifier. The unique public identity of this model"),
    LegacyModelSchema,
  ),
})

export function createLegacyModelJsonSchema(){
  return LegacyModelFileSchema.toJSONSchema({
    cycles: "ref",
    io: "input",
  })
}

if (import.meta.main) {
  const write = (name: string, schema: unknown) =>
    Bun.write(`${import.meta.dir}/../${name}`, `${JSON.stringify(schema, null, 2)}\n`);

  await write("models.v2.schema.json", createModelJsonSchema());
  await write("models.schema.json", createLegacyModelJsonSchema());
}
