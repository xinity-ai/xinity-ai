import { z } from "zod";
import { LicenseSchema } from "./licenses";
import { kvCacheFloorGb } from "../kv-cache-floor";
import { engineProfile } from "../../deployment-footprint";
import { isValidVersionRange } from "../semver";
import {
  BLOCKED_REQUEST_PARAM_PREFIXES,
  EngineEnum,
  EngineVersionEffectEnum,
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
  weightGb: z.number().describe("Memory consumed by this variant's weights, in GB, wherever the engine keeps them"),
  activeWeightGb: z.number().optional().describe("Weights read per token by a mixture-of-experts variant, in GB. Present exactly when the model is a mixture of experts, so it must be set for every one: it decides the concurrency knee and, when the model spans nodes, the extra collective communicator its experts need. Absent means dense, where every weight participates. Capacity still needs the full weight"),
  largestFileGb: z.number().positive().optional().describe("Size of the largest weight file in the checkpoint, in GB. Loading holds copies of up to a few such files in host memory besides the installation's steady part"),
  hostWeightGb: z.number().min(0).optional().describe("Part of weightGb this entry's engine keeps in host memory instead of on the GPU, in GB, for example n-gram embedding tables. 0 when every weight is on the GPU. Stating it, 0 included, marks the entry as checked across nodes: without it the entry is placed on one node only, where it counts as 0"),
  nonLayerWeightGb: z.number().min(0).optional().describe("Part of weightGb outside the decoder layer stack, in GB: input embedding, output head, vision and audio encoders. These sit on the first or last stage when the model is split by layers"),
  layers: z.number().int().positive().optional().describe("Decoder layers in the layer stack, num_hidden_layers in config.json, without speculative draft layers"),
  attentionLayers: z.number().int().positive().optional().describe("Layers that cache keys and values per token, including a speculative draft layer this entry enables. kvBytesPerToken is spread over these, which the engine pages per layer"),
  stateLayers: z.number().int().positive().optional().describe("Layers holding a fixed recurrent state per request, such as Mamba or gated deltanet layers. stateBytesPerSequence is spread over these. Absent for pure attention models"),
  weightBits: z.number().positive().max(32).optional().describe("Nominal bits per stored parameter, e.g. 16 for fp16 or 4 for AWQ. Never an exact average: every method leaves parts of the network wider than its headline width, commonly attention projections, embeddings and norms. Dividing weightGb by it yields a parameter count good enough to estimate throughput from, and good for nothing that needs the real one"),
  minKvCacheGb: z.number().optional().describe("Minimum KV-cache allocation in decimal GB. Optional once kvBytesPerToken is stated, because the floor then follows from it: one request at full context in whole 16-token blocks plus the block the engine keeps in reserve, and for a hybrid model its per-sequence state. Author it only to demand more than that floor, and expect the server to log any entry whose figure disagrees with the derived one by more than a factor of two"),
  kvBytesPerToken: z.number().int().positive().optional().describe("KV cache one token of context consumes, in bytes, i.e. 2 * num_hidden_layers * num_key_value_heads * head_dim * dtype_bytes. How many requests a deployment can serve at once follows from this and the cache it was given, so it is the figure concurrency is computed from"),
  maxContextLength: z.number().int().positive().describe("Maximum supported context window in tokens"),
  attentionWindow: z.number().int().positive().optional().describe("Sliding-window attention span in tokens, for models that have one. KV per request stops growing past this point, so a windowed model needs far less cache at long context than kvBytesPerToken alone suggests"),
  stateBytesPerSequence: z.number().int().positive().optional().describe("Recurrent state one concurrent request consumes, in bytes, for hybrid architectures whose layers are not all attention, such as Mamba or gated deltanet. Unlike kvBytesPerToken this does not grow with context: it is a fixed cost per request in flight. Present only for hybrid models, and vLLM refuses to start when its per-sequence state does not fit, so a concurrency cap that ignores it can be one the engine rejects"),
  attentionHeads: z.number().int().positive().optional().describe("Attention heads per layer of the language model, num_attention_heads in config.json"),
  kvHeads: z.number().int().positive().optional().describe("Key/value heads per layer of the language model, num_key_value_heads in config.json. Equal to attentionHeads without grouped-query attention, fewer with it"),
  mlaAttention: z.boolean().optional().describe("Whether the model uses multi-head latent attention, as DeepSeek V2 and V3 do, caching one compressed latent per token instead of keys and values per head"),
}).refine(
  sizing => sizing.kvHeads === undefined
    || (sizing.attentionHeads !== undefined && sizing.kvHeads <= sizing.attentionHeads),
  { message: "kvHeads needs attentionHeads, and must not exceed it", path: ["kvHeads"] },
).refine(
  sizing => sizing.activeWeightGb === undefined || sizing.activeWeightGb <= sizing.weightGb,
  { message: "activeWeightGb must not exceed weightGb", path: ["activeWeightGb"] },
).refine(
  sizing => sizing.hostWeightGb === undefined || sizing.hostWeightGb <= sizing.weightGb,
  { message: "hostWeightGb must not exceed weightGb", path: ["hostWeightGb"] },
).refine(
  sizing => sizing.nonLayerWeightGb === undefined || sizing.nonLayerWeightGb <= sizing.weightGb,
  { message: "nonLayerWeightGb must not exceed weightGb", path: ["nonLayerWeightGb"] },
).refine(
  sizing => sizing.minKvCacheGb !== undefined || sizing.kvBytesPerToken !== undefined,
  { message: "state kvBytesPerToken, or minKvCacheGb directly", path: ["minKvCacheGb"] },
).transform(sizing => ({
  ...sizing,
  // The refine above guarantees kvBytesPerToken whenever minKvCacheGb is absent, and one card always
  // splits. No node version is known while parsing, so the newest engine paging applies.
  minKvCacheGb: sizing.minKvCacheGb ?? kvCacheFloorGb(sizing, { ranks: 1, speculativeTokens: 0 }, engineProfile().paging)!,
}));

export type ModelSizingFields = z.infer<typeof ModelSizing>;

/** Authored versions are written clean. PEP440 is the shape a node reports, not one to state here. */
const COMPLETE_VERSION = /^\d+\.\d+\.\d+$/;

export const EngineVersionRule = z.object({
  range: z.string().refine(isValidVersionRange, "Expected comparators over complete versions, e.g. \">=0.27.0 <0.27.3\"")
    .describe("The releases this rule is about, as a single version or a range"),
  effect: EngineVersionEffectEnum.describe("What the rule says about them. `blocked` keeps the model off nodes running one"),
  reason: z.string().describe("Why, in a sentence an operator can act on. For a block, what goes wrong and which release fixes it where that is known"),
});

export type EngineVersionRuleFields = z.infer<typeof EngineVersionRule>;

/**
 * A rule whose effect this version does not know is dropped rather than guessed at.
 * Guessing the wrong way round turns a future `preferred` range into an exclusion and
 * empties the cluster, so silence is the only safe reading.
 */
const relayedEngineVersionRules = z.array(z.unknown()).transform(rules =>
  rules.filter((rule): rule is EngineVersionRuleFields => EngineVersionRule.safeParse(rule).success),
);

const engineVersionFields = {
  min: z.string().regex(COMPLETE_VERSION, "Expected a complete version, e.g. 0.21.0").optional()
    .describe("Oldest engine version that serves this model correctly. Establish it empirically: a version can load cleanly and still fail the first request"),
  rules: z.array(EngineVersionRule).min(1).optional()
    .describe("What specific releases at or above the floor do. A model can carry these without having a known floor"),
};

const statesSomething = {
  check: (versions: { min?: string; rules?: unknown[] }) => versions.min !== undefined || versions.rules !== undefined,
  message: "state min, rules, or both",
};

export const EngineVersions = z.object(engineVersionFields)
  .refine(statesSomething.check, { message: statesSomething.message });

export const RelayedEngineVersions = z.object({ ...engineVersionFields, rules: relayedEngineVersionRules.optional() })
  .refine(statesSomething.check, { message: statesSomething.message });

const placementLimitFields = {
  reason: z.string().describe("Why, in a sentence shown to someone choosing where to deploy"),
  engineRange: z.string().refine(isValidVersionRange, "Expected comparators over complete versions, e.g. \"<0.33.0\"").optional()
    .describe("The engine releases this limit applies to, as a version range. Absent means every release"),
};

const PlacementLimit = z.discriminatedUnion("limit", [
  z.object({
    limit: z.literal("nodes"),
    max: z.number().int().positive().describe("Most machines one installation may span"),
    ...placementLimitFields,
  }),
  z.object({
    limit: z.literal("cards"),
    max: z.number().int().positive().describe("Most cards one installation may span, over all its machines"),
    ...placementLimitFields,
  }),
  z.object({
    limit: z.literal("splitSizes"),
    values: z.array(z.number().int().positive()).min(1).describe("The only numbers of cards one installation may be split across"),
    ...placementLimitFields,
  }),
]);

export type PlacementLimitFields = z.infer<typeof PlacementLimit>;

export const Placement = z.object({
  limits: z.array(PlacementLimit).default([])
    .describe("Restrictions on how an installation may be split that follow from no other field"),
});

// A limit this version does not know may forbid what it would otherwise allow, so it is read as the
// strictest one every version can honour.
const UNKNOWN_PLACEMENT_LIMIT: PlacementLimitFields = {
  limit: "cards",
  max: 1,
  reason: "This entry carries a placement rule this version does not know, so it runs on a single card",
};

export const RelayedPlacement = z.object({
  limits: z.array(z.unknown()).default([]).transform(limits => limits.map(limit => {
    const parsed = PlacementLimit.safeParse(limit);
    return parsed.success ? parsed.data : UNKNOWN_PLACEMENT_LIMIT;
  })),
});

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
  engineVersions: EngineVersions.optional().describe("What this model needs of the engine version, and what specific releases do. Nodes running a blocked release are passed over when placing the model"),
  platforms: z.array(GpuVendorEnum).optional().describe("GPU vendor requirement. Absent means any platform"),
  placement: Placement.default({ limits: [] }).describe("How an installation of this entry may be placed and split"),

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
  engineVersions: RelayedEngineVersions.optional(),
  placement: RelayedPlacement.default({ limits: [] }),
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

/** Wide enough that an empirically confirmed floor and its overhead still pass. A factor beyond it
 * means the arithmetic itself is wrong, e.g. K and V counted once or the cache dtype misread. */
const KV_MISMATCH_FACTOR = 2;

export type KvCacheMismatch = { minKvCacheGb: number; impliedGb: number; ratio: number };

export function kvCacheMismatch(sizing: ModelSizingFields): KvCacheMismatch | undefined {
  const impliedGb = kvCacheFloorGb(sizing, { ranks: 1, speculativeTokens: 0 }, engineProfile().paging);
  if (impliedGb === undefined) {
    return undefined;
  }

  const ratio = sizing.minKvCacheGb / impliedGb;
  if (ratio >= 1 / KV_MISMATCH_FACTOR && ratio <= KV_MISMATCH_FACTOR) {
    return undefined;
  }

  return {
    minKvCacheGb: sizing.minKvCacheGb,
    impliedGb: Number(impliedGb.toFixed(2)),
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
