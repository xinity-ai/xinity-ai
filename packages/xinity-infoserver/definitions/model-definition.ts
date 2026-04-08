import { z } from "zod";

export const ProviderEnum = z.enum(["vllm", "ollama"]);
export type Provider = z.infer<typeof ProviderEnum>;

export const TagEnum = z.enum(["tools", "custom_code", "vision"]);
export type Tag = z.infer<typeof TagEnum>;

export const GpuVendorEnum = z.enum(["nvidia", "amd", "intel"]);
export type GpuVendor = z.infer<typeof GpuVendorEnum>;

/**
 * vLLM args that must not appear in providerArgs because they are either
 * auto-derived from tags or managed by the system.
 */
export const BLOCKED_VLLM_ARGS = new Set([
  "--trust-remote-code",       // controlled by custom_code tag
  "--enable-auto-tool-choice", // auto-derived from tools tag
  "--runner",                  // auto-derived from model type (embedding/rerank → pooling)
  "--task",                    // deprecated in favor of --runner, auto-managed
  "--host",                    // system-managed
  "--port",                    // system-managed
  "--served-model-name",       // system-managed
  "--kv-cache-memory-bytes",   // system-managed via kvCacheCapacity
  "--gpu-memory-utilization",  // system-managed, calculated from model needs and total VRAM
  "--api-key",                 // system-managed
]);

/**
 * Request-level parameter paths that must never be forwarded to backends,
 * regardless of model configuration. Defense-in-depth against known CVEs.
 */
export const BLOCKED_REQUEST_PARAM_PREFIXES = [
  "chat_template",  // Jinja injection vector (CVE-2025-61620), note: chat_template_kwargs is fine
  "tokenize",       // DoS vector (CVE-2025-62426)
  "prompt",         // prompt override
  "api_key",        // credential leak
];

/** Allowed primitive type names for requestParams values. */
export const RequestParamTypeEnum = z.enum(["boolean", "number", "string"]);
export type RequestParamType = z.infer<typeof RequestParamTypeEnum>;

type NestedStringItem = string | NestedStringItem[];
const nestedStringItem: z.ZodType<NestedStringItem> = z.lazy(() =>
  z.union([z.string(), z.array(nestedStringItem)])
);

const flatStringArray = z.array(nestedStringItem)
  .transform((arr): string[] => (arr as unknown[]).flat(Infinity) as string[])
  .pipe(z.array(z.string()));

const vllmArgs = flatStringArray
  .transform((args: string[]) => {
    const result: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (BLOCKED_VLLM_ARGS.has(args[i]!)) {
        if (args[i + 1] && !args[i + 1]!.startsWith("--")) {
          i++;
        }
      } else {
        result.push(args[i]!);
      }
    }
    return result;
  });

export const ModelSchema = z.looseObject({
  name: z.string().describe("Display name of the model. Intended to be easily human readable"),
  description: z.string().describe("Brief description of the model and its unique properties"),
  weight: z.number().describe("Relative weight of how much strain the model places on the node it is installed on"),
  minKvCache: z.number().describe(
    "Minimum KV-cache allocation in GB. " +
    "Should be precomputed from the model's config.json (if available) as roughly: " +
    "2 * num_hidden_layers * num_key_value_heads * head_dim * dtype_bytes * total_tokens, " +
    "where total_tokens is chosen based on desired concurrent capacity."
  ),
  url: z.url().describe("External documentation url, for curious users that want to know more"),
  type: z.enum(["embedding", "chat", "rerank"]).default("chat").optional().describe("Usage type of the model in question"),
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
    (obj) => {
      for (const driverParams of Object.values(obj)) {
        if (!driverParams) continue;
        for (const dotPath of Object.keys(driverParams)) {
          const topLevel = dotPath.split(".")[0];
          if (BLOCKED_REQUEST_PARAM_PREFIXES.some(prefix => topLevel === prefix)) {
            return false;
          }
        }
      }
      return true;
    },
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
  contextLength: z.number().positive().optional().describe("Maximum context window size in tokens"),
  custom: z.looseObject({
    baseModel: z.string(),
    extraFacts: z.record(z.string(), z.any())
  }).optional().describe("Info for fine tuned custom models"),
});
export type Model = z.infer<typeof ModelSchema>;
export type ModelWithSpecifier = Model & { publicSpecifier: string; _source: string };

export const ModelFileDefinitionSchema = z.object({
  includes: z.url().array().describe([
    "Include instruction. Will result in fetch attempts for additional model sources.",
    "Global uniqueness of model identifiers persists"
  ].join("\n")).optional(),
  models: z.record(
    z.string().describe("Public model specifier. The unique public identity of this model"),
    ModelSchema,
  ),
})

export function createModelJsonSchema(){
  return ModelFileDefinitionSchema.toJSONSchema({
    cycles: "ref",
    io: "input",
  })
}

if (import.meta.main) {
  console.log(JSON.stringify(createModelJsonSchema(), null, 2));
}
