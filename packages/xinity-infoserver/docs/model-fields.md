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
| `sizing` | object | What the variant costs to run, see [Sizing](#sizing) below |

## Capabilities

These fields control what the model can do at runtime. Getting them wrong causes request failures.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"chat"` \| `"embedding"` \| `"rerank"` \| `"transcription"` | `"chat"` | Determines which API endpoints accept the model. A rerank request to a chat model is rejected as incompatible |
| `tags` | string[] | `[]` | Enables specific capabilities: `"tools"` (tool/function calling), `"vision"` (image inputs). Requests using a capability the model lacks are rejected. `"tools"` also requires `engineArgs: ["--tool-call-parser", "<name>"]` (the daemon adds `--enable-auto-tool-choice` from the tag, but vLLM needs the model-specific parser too). Research and **validate** each capability against a running server before declaring it - see "Validate declared capabilities" in [integrating-a-model.md](./integrating-a-model.md). `"custom_code"` marks models that ship custom loading code requiring vLLM's `--trust-remote-code` flag, and triggers an explicit approval step in the dashboard. Only add if the model fails to load without it |

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

Adding to `engine`, `type`, `tags`, `platforms`, an `engineVersions.rules` effect, a `placement.limits` kind or license `use` is not a breaking change. In a catalog read over `includes`, unknown tags and platforms are filtered out and unknown engines or types skip the entry, a version rule naming an unknown effect is dropped on its own, and a placement limit of an unknown kind is read as a single-card limit, so older readers lose only what they could not have used and never place an entry more widely than its author allowed. In a local file an unknown value is a typo and fails the load.

Redefining or removing a value is breaking, since deployed readers keep the old meaning.

## Dates

Dates are written `YYYY-MM-DD`.  

`createdAt` is the model's own release date, taken from its creator: the HuggingFace commit that first published the weights, or the vendor's announcement. It stays fixed for the life of the entry, and it is the same date across every engine and quantization variant of one model. Recency is one of the strongest signals of capability a user has when comparing two models they know nothing else about, which is why it is required rather than nice to have.

`registeredAt` is the day the entry was added here. It has nothing to do with the model's age: a model published two years ago that you integrate today is newly registered, not new. The dashboard flags entries registered within the last 14 days so users notice additions, so backdating one hides it and postdating one keeps the flag up. When a variant of an already-integrated model is added, only the new entry gets today's date.

## Optional fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `family` | string | `"unknown"` | Model family, shown to the user as the group label in the picker. Write it as a human-readable name, capitalised the way the vendor writes it: `"Qwen3"`, `"Mistral Small"`, `"Granite 4"`, not `"qwen3"` or `"mistral-small"`. Entries sharing a label are grouped together, so it has to match exactly across a family |
| `variantOf` | string | - | Specifier of the standard variant of this model. Set it on the derived variants and leave it off the one they derive from, so the group has exactly one leader. A variant may not itself have variants, and a pointer at a missing entry leaves the entry ungrouped rather than failing. Every variant keeps its own license, description and capacity, since a requant can carry different terms and needs its own operational notes |
| `isCustom` | boolean | `false` | Marks fine-tuned/custom models |
| `unlisted` | boolean | `false` | Hides the entry from the model picker without retiring it. Existing deployments keep resolving, and a user can unhide it or name its specifier exactly. Use it for models that are outdated or that you would not recommend, rather than deleting the entry |
| `unlistedReason` | string | - | Shown when the entry is unhidden. Optional: leave it out when the model is simply old, and set it when the reason changes what a user should do, e.g. a relicensed model whose terms are no longer offered |
| `minXinityVersion` | string | - | Minimum xinity-ai version this entry requires. Older clients skip entries they are too old for. Set it only for an entry that genuinely needs a newer client: an entry naming a version nobody is running yet is invisible |
| `engineArgs` | string[] | - | Extra CLI arguments appended to the engine's server command. Arrays are deeply flattened to support YAML anchors. Some are blocked, see below |
| `requestParams` | Record\<string, `"boolean"` \| `"number"` \| `"string"`\> | - | Allowlist of request-level parameters the gateway may forward to the backend. Dot-notation paths (e.g. `top_p`, `repetition_penalty`). Params not listed are dropped |
| `downloadFilter` | string[] | - | Gitignore-style glob patterns appended to the daemon's default HuggingFace download filter. Patterns starting with `!` re-include, and the last matching rule wins. Arrays are deeply flattened to support YAML anchors. Example: `["*.gguf", "!consolidated.safetensors"]` |

## Sizing

Everything the variant costs to run. Grouped because these figures are read together and set together, and because every one of them is specific to this engine and this quantization.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `weightGb` | number | required | Memory consumed by this variant's weights, in GB, wherever the engine keeps them |
| `hostWeightGb` | number | - | Part of `weightGb` the engine keeps in host memory instead of on the GPU, in GB, for example n-gram embedding tables. 0 when every weight is on the GPU. Stating it, 0 included, marks the entry as checked across nodes: without it the entry is placed on one node only, where it counts as 0. Set it only after the entry has passed a run across two nodes |
| `nonLayerWeightGb` | number | - | Part of `weightGb` outside the decoder layer stack, in GB: input embedding, output head, vision and audio encoders. These sit on the first or last stage when a model is split by layers |
| `layers` | number | - | Decoder layers in the layer stack (`num_hidden_layers`), without speculative draft layers |
| `attentionLayers` | number | - | Layers that cache keys and values per token, including a speculative draft layer the entry enables. `kvBytesPerToken` is spread over these, and the engine pages KV per layer |
| `stateLayers` | number | - | Layers holding a fixed recurrent state per request (Mamba, gated deltanet). `stateBytesPerSequence` is spread over these. Absent for pure attention models |
| `minKvCacheGb` | number | derived | Minimum KV-cache allocation in GB (decimal, 10⁹). The floor below which vLLM refuses to start: KV for one request at full context, allocated in whole 16-token blocks plus the one block vLLM keeps in reserve, plus `stateBytesPerSequence` for a hybrid model, paged the way vLLM pages it once the entry states `attentionLayers` and `stateLayers`. Derived from `kvBytesPerToken` when absent, rounded up, so an entry stating that field needs nothing here. Author it only to demand **more** than the floor. Every entry must state one of the two |
| `maxContextLength` | number | required | Maximum supported context window, in tokens. Used by the gateway to enforce per-model context limits (e.g. in the Responses API) and reported via `GET /v1/models`. **Not** passed to the engine: an entry clipping its context below the model's own config has to state `--max-model-len` in `engineArgs` as well, see ["`maxContextLength` is not passed to the engine"](./integrating-a-model.md#maxcontextlength-is-not-passed-to-the-engine) |
| `activeWeightGb` | number | - | Weights read per token, in GB, for a mixture-of-experts variant. Present exactly when the model is a mixture of experts, so set it for every one: absent means dense. It decides the concurrency knee, and when the model spans nodes, the extra collective communicator its experts need. Capacity is unaffected: the full `weightGb` still has to fit |
| `weightBits` | number | - | **Nominal** bits per stored parameter: 16 for fp16/bf16, 8 for fp8 or `q8_0`, 4 for AWQ/GPTQ. Write the headline width of the method, not a computed average, and see [Weight precision](#weight-precision) for why the two are never the same |
| `kvBytesPerToken` | number | - | KV cache one token of context consumes, in bytes: `2 × num_hidden_layers × num_key_value_heads × head_dim × dtype_bytes`. This is the factor `minKvCacheGb` is built from, kept instead of discarded, because how many requests a deployment serves at once follows from it. Loading an authored file warns when the two disagree by more than a factor of two. |
| `attentionWindow` | number | - | Sliding-window attention span in tokens, for models that have one. KV per request stops growing past this point, so without it a windowed model looks far more expensive at long context than it is |
| `stateBytesPerSequence` | number | - | Recurrent state one concurrent request consumes, in bytes, for hybrid architectures whose layers are not all attention. A fixed cost per request in flight rather than one that grows with context, so it bounds concurrency in a way shortening the context cannot relieve. See [Hybrid architectures](#hybrid-architectures) |
| `attentionHeads` | number | - | Attention heads per layer of the language model (`num_attention_heads`) |
| `kvHeads` | number | - | Key/value heads per layer of the language model (`num_key_value_heads`). Equal to `attentionHeads` without grouped-query attention, fewer with it. Needs `attentionHeads` and must not exceed it |
| `overheadGb` | number | - | Deprecated and no longer read. The engine's own memory depends on how a deployment is split, not on the model, so it comes from the engine profile for the layout. Do not set it |
| `mlaAttention` | boolean | - | `true` when the model uses multi-head latent attention, as DeepSeek V2 and V3 do, caching one compressed latent per token instead of keys and values per head |

## Hybrid architectures

Models that mix attention with a recurrent layer type, Mamba or gated deltanet, do not pay for concurrency the way a pure attention model does. Their attention layers still cost `kvBytesPerToken` per token of context, but their recurrent layers hold a fixed-size state per request in flight, and vLLM allocates that state up front as one block per sequence.

This is why such a model can refuse to start at a batch size a pure attention model of the same weight would accept. vLLM's default `max_num_seqs` rose from 256 to 1024 with the V1 engine, and on a hybrid model that increase alone can push the state allocation past what the cache holds, failing at CUDA-graph capture rather than at the usual `max_model_len` check.

`stateBytesPerSequence` is therefore not an optimization hint. A concurrency figure computed without it is one the engine may reject.

## Weight precision

No method applies one width to the whole network. AWQ and GPTQ quantize the linear projections and leave the embeddings, the LM head and the norms at fp16. K-quants mix widths per tensor by design. An fp8 checkpoint often keeps attention in bf16. The true average across a checkpoint is therefore always above the headline width, and it is not something an integrator can read off a model card.

So `weightBits` records the headline width, which is the only figure anyone can state reliably. Consumers must treat the parameter count derived from it as an estimate: it comes out slightly high, which biases throughput estimates low, and that direction is deliberate. Nothing should present it as the model's exact parameter count.

## Compatibility constraints

| Field | Type | Description |
|-------|------|-------------|
| `engineVersions` | object | Which engine versions serve this model, see [Engine versions](#engine-versions) below |
| `platforms` | string[] (GPU vendors) | Required GPU vendors. Nodes without a matching GPU are excluded. Values: `"nvidia"`, `"amd"`, `"intel"`. Example: `[nvidia]` for models with CUDA-only kernels |
| `placement` | object | How an installation may be placed and split, see [Placement limits](#placement-limits) below |

Unset means unconstrained: any engine version, any platform, any split the model's facts allow.

### Placement limits

`placement.limits` lists restrictions on splitting an installation that follow from no other field.
What the other fields already decide is not restated here: splitting across cards needs
`attentionHeads` and `kvHeads` and only uses sizes they divide by, and spanning nodes needs
`hostWeightGb`.

```yaml
placement:
  limits:
    - limit: nodes
      max: 1
      reason: The n-gram tables cannot be split across machines yet.
      engineRange: "<0.33.0"
    - limit: splitSizes
      values: [1, 2, 4]
      reason: FP8 blocks of 128 do not divide at other sizes.
```

| Field | Applies to | Description |
|-------|-----------|-------------|
| `limit` | every rule | The kind of rule: `nodes`, `cards` or `splitSizes` |
| `max` | `nodes`, `cards` | Most machines, or most cards over all machines, one installation may span |
| `values` | `splitSizes` | The only numbers of cards one installation may be split across |
| `reason` | every rule | Why, in a sentence shown to someone choosing where to deploy |
| `engineRange` | every rule, optional | The engine releases the rule applies to, as a version range. Absent means every release, so a rule a later release lifts can expire on its own |

In a local file an unknown `limit` is a typo and fails the load. In a catalog read over `includes`,
a rule this version cannot read is not dropped, since dropping it would allow what its author meant
to forbid: it is read as a single-card limit instead.

### Engine versions

State at least one of the two. Both are enforced only when the node's engine version is detectable.

| Field | Type | Description |
|-------|------|-------------|
| `min` | string | Oldest engine version that serves this model correctly. Nodes running an older one are passed over when placing the model. Write a complete version, e.g. `"0.19.1"`, with no `v` prefix and no PEP440 suffix: that is the shape a *node* reports, and it is normalised at comparison time rather than authored here. Establish the floor empirically rather than guessing, see "Confirm the version floor" in [integrating-a-model.md](./integrating-a-model.md) |
| `rules` | object[] | What specific releases at or above the floor do, see [Version rules](#version-rules) below. A model can carry rules without having a known floor |

```yaml
    engineVersions:
      min: "0.19.1"
      rules:
        - range: ">=0.27.0 <0.27.3"
          effect: blocked
          reason: Attention kernel shape mismatch on this head_dim. Fixed in 0.27.3.
```

### Version rules

A rule names a set of releases and says what they mean for this model. Today one effect
exists. The shape is a list of rules rather than a list of bad versions so that a later
effect, say marking a range as the one a model runs best on, is a new value here rather
than a new field.

| Field | Type | Description |
|-------|------|-------------|
| `range` | string | The releases the rule is about. A single version (`"0.27.1"`), comparators ANDed by spaces (`">=0.27.0 <0.27.3"`), or alternatives ORed by `\|\|`. Deliberately narrower than semver's own grammar: complete versions only, and no `^`, `~`, `x` or hyphen ranges, because an exclusion is always a concrete interval |
| `effect` | `"blocked"` | What the rule says. `blocked` keeps the model off nodes running one of these releases |
| `reason` | string | Why, in a sentence an operator can act on. For a block, what goes wrong and which release fixes it where that is known. This text is shown in the model picker, so it is the difference between "no node can run this" and knowing whether to upgrade, pin or wait |

An entry read over `includes` that carries an effect this version does not define has
that **rule** dropped, not the entry. Reading an unknown effect as a block would let a
future "preferred" range empty a cluster, so an unreadable rule is ignored instead. In a
local file it is a typo and fails the load.

### Blocked vLLM arguments

These arguments are system-managed and silently stripped from `engineArgs`:

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
