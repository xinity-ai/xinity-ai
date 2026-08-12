# Model field reference

Complete reference for every field in the `ModelSchema`. See the [README](../README.md) for usage examples and guides.

For IDE autocomplete, use the JSON Schema at `/schemas/model.v2.json` (served by the infoserver) or generate it locally with `bun run refresh-schema`.

One entry describes one model on one engine, so every number below applies to that exact variant. A quantized Ollama variant and an fp16 vLLM variant of the same model are two entries.

## Required fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name shown in the dashboard model selector |
| `description` | string | Multi-paragraph description shown in the dashboard model selector: purpose, strengths, limitations. Use a YAML block scalar (`description: \|`). A one-line label is not enough, since this is what a user reads to choose between models |
| `url` | URL | External documentation link (e.g. HuggingFace page) |
| `license` | string \| object | License terms. Either a well-known identifier or a full object, see [Licenses](#licenses) below |
| `createdAt` | date | Day the model was published by its creator, see [Dates](#dates) below |
| `registeredAt` | date | Day this entry was added to the catalog, see [Dates](#dates) below |
| `engine` | `"vllm"` \| `"ollama"` | Inference engine this entry runs on |
| `engineSpecifier` | string | The identifier the engine itself uses: a HuggingFace model ID for vLLM (`"meta-llama/Llama-3.1-8B-Instruct"`), a tag for Ollama (`"llama3.1:8b-instruct-fp16"`) |
| `weight` | number | VRAM consumed by this variant's weights, in GB |
| `minKvCache` | number | Minimum KV-cache allocation in GB (decimal, 10⁹ - use a decimal, not a rounded integer). It is the floor below which vLLM refuses to start (KV for one request at full context). vLLM reports that floor in GiB, so the field value is `floor_GiB × 1.074`. Confirm it empirically - see "Confirm the KV-cache floor" in [integrating-a-model.md](./integrating-a-model.md) |
| `maxContextLength` | number | Maximum supported context window, in tokens. Used by the gateway to enforce per-model context limits (e.g. in the Responses API) and reported via `GET /v1/models` |

## Capabilities

These fields control what the model can do at runtime. Getting them wrong causes request failures.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"chat"` \| `"embedding"` \| `"rerank"` \| `"transcription"` | `"chat"` | Determines which API endpoints accept the model. A rerank request to a chat model is rejected as incompatible |
| `tags` | string[] | `[]` | Enables specific capabilities: `"tools"` (tool/function calling), `"vision"` (image inputs). Requests using a capability the model lacks are rejected. `"tools"` also requires `args: ["--tool-call-parser", "<name>"]` (the daemon adds `--enable-auto-tool-choice` from the tag, but vLLM needs the model-specific parser too). Research and **validate** each capability against a running server before declaring it - see "Validate declared capabilities" in [integrating-a-model.md](./integrating-a-model.md). `"custom_code"` marks models that ship custom loading code requiring vLLM's `--trust-remote-code` flag, and triggers an explicit approval step in the dashboard. Only add if the model fails to load without it |

## Licenses

`license` accepts a well-known identifier, which the server expands into the object below, or the object written out in full. A published catalog only ever carries the object form.

Recognised identifiers: `apache-2.0`, `mit`, `bsd-3-clause`, `mpl-2.0`, `gpl-3.0`, `agpl-3.0`, `cc-by-4.0`, `cc-by-sa-4.0`, `cc-by-nc-4.0`.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name of the license |
| `url` | URL | Link to the license text. For an unstated license, link the page a user should check instead |
| `use` | `"open"` \| `"conditional"` \| `"non-commercial"` \| `"unknown"` | How far the license restricts using the model. Defaults to `unknown` when absent |
| `summary` | string | One or two sentences on what a user may and may not do. **Required unless `use` is `open`** |
| `id` | string | SPDX identifier when this is a standard license. Display only, set automatically by the shorthand |

`use` describes freedom to use, not obligations on redistribution, so copyleft licenses are `open`.

An unrecognised `use` value is read as `unknown` rather than failing validation, so adding a value later does not break clients running an older version: they show the summary and the link instead of a classification. The value must never be widened to a free-form string, and the fallback must never become `open`.

## Adding a value to a fixed set

Adding to `engine`, `type`, `tags`, `platforms` or license `use` is not a breaking change. In a catalog read over `includes`, unknown tags and platforms are filtered out and unknown engines or types skip the entry, so older readers lose only what they could not have used. In a local file an unknown value is a typo and fails the load.

Redefining or removing a value is breaking, since deployed readers keep the old meaning.

## Dates

Dates are written `YYYY-MM-DD`.  

`createdAt` is the model's own release date, taken from its creator: the HuggingFace commit that first published the weights, or the vendor's announcement. It stays fixed for the life of the entry, and it is the same date across every engine and quantization variant of one model. Recency is one of the strongest signals of capability a user has when comparing two models they know nothing else about, which is why it is required rather than nice to have.

`registeredAt` is the day the entry was added here. It has nothing to do with the model's age: a model published two years ago that you integrate today is newly registered, not new. The dashboard flags entries registered within the last 14 days so users notice additions, so backdating one hides it and postdating one keeps the flag up. When a variant of an already-integrated model is added, only the new entry gets today's date.

## Optional fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `activeWeight` | number | - | Weights read per token, in GB, for a mixture-of-experts variant. Absent means dense. Throughput scales with this rather than with `weight`, so a sparse model left without it reads as far slower than it is. Capacity is unaffected: the full `weight` still has to fit in VRAM |
| `weightBits` | number | - | **Nominal** bits per stored parameter: 16 for fp16/bf16, 8 for fp8 or `q8_0`, 4 for AWQ/GPTQ. Write the headline width of the method, not a computed average, and see [Weight precision](#weight-precision) for why the two are never the same |
| `family` | string | `"unknown"` | Model family for grouping in the UI (e.g. `"llama"`, `"phi3"`, `"mistral"`) |
| `variantOf` | string | - | Specifier of the standard variant of this model. Set it on the derived variants and leave it off the one they derive from, so the group has exactly one leader. A variant may not itself have variants, and a pointer at a missing entry leaves the entry ungrouped rather than failing. Every variant keeps its own license, description and capacity, since a requant can carry different terms and needs its own operational notes |
| `isCustom` | boolean | `false` | Marks fine-tuned/custom models |
| `unlisted` | boolean | `false` | Hides the entry from the model picker without retiring it. Existing deployments keep resolving, and a user can unhide it or name its specifier exactly. Use it for models that are outdated or that you would not recommend, rather than deleting the entry |
| `unlistedReason` | string | - | Shown when the entry is unhidden. Optional: leave it out when the model is simply old, and set it when the reason changes what a user should do, e.g. a relicensed model whose terms are no longer offered |
| `entryVersion` | string | - | Minimum xinity-ai version this entry requires. Older clients skip entries they are too old for. Set it only for an entry that genuinely needs a newer client: an entry naming a version nobody is running yet is invisible |
| `args` | string[] | - | Extra CLI arguments appended to the engine's server command. Arrays are deeply flattened to support YAML anchors. Some args are blocked, see below |
| `requestParams` | Record\<string, `"boolean"` \| `"number"` \| `"string"`\> | - | Allowlist of request-level parameters the gateway may forward to the backend. Dot-notation paths (e.g. `top_p`, `repetition_penalty`). Params not listed are dropped |
| `downloadFilter` | string[] | - | Gitignore-style glob patterns appended to the daemon's default HuggingFace download filter. Patterns starting with `!` re-include, and the last matching rule wins. Arrays are deeply flattened to support YAML anchors. Example: `["*.gguf", "!consolidated.safetensors"]` |

## Weight precision

No method applies one width to the whole network. AWQ and GPTQ quantize the linear projections and leave the embeddings, the LM head and the norms at fp16. K-quants mix widths per tensor by design. An fp8 checkpoint often keeps attention in bf16. The true average across a checkpoint is therefore always above the headline width, and it is not something an integrator can read off a model card.

So `weightBits` records the headline width, which is the only figure anyone can state reliably. Consumers must treat the parameter count derived from it as an estimate: it comes out slightly high, which biases throughput estimates low, and that direction is deliberate. Nothing should present it as the model's exact parameter count.

## Compatibility constraints

| Field | Type | Description |
|-------|------|-------------|
| `minEngineVersion` | string (semver) | Minimum engine version required. Nodes with older versions are excluded from scheduling. Example: `"0.19.1"`. Establish the floor empirically rather than guessing - see "Confirm the version floor" in [integrating-a-model.md](./integrating-a-model.md). Enforced only when the node's engine version is detectable |
| `platforms` | string[] (GPU vendors) | Required GPU vendors. Nodes without a matching GPU are excluded. Values: `"nvidia"`, `"amd"`, `"intel"`. Example: `[nvidia]` for models with CUDA-only kernels |

Unset means unconstrained: any engine version, any platform.

### Blocked vLLM arguments

These arguments are system-managed and silently stripped from `args`:

`--trust-remote-code`, `--enable-auto-tool-choice`, `--runner`, `--task`, `--host`, `--port`, `--served-model-name`, `--kv-cache-memory-bytes`, `--gpu-memory-utilization`, `--api-key`

### Blocked request parameters

These prefixes are never forwarded regardless of `requestParams` configuration:

`chat_template` (CVE-2025-61620), `tokenize` (CVE-2025-62426), `prompt`, `api_key`

## File-level fields

These appear at the top level of the YAML file, not inside a model definition.

| Field | Type | Description |
|-------|------|-------------|
| `includes` | URL[] | List of remote model source URLs to merge. Each must use this same format. Local models take precedence over remote includes with the same specifier. Recursive includes are supported with cycle detection |
| `models` | Record\<string, Model\> | Map of public specifier to model definition. The specifier carries the engine, e.g. `gemma-4-27b-vllm` |
