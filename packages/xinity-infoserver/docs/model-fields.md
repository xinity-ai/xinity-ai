# Model field reference

Complete reference for every field in the `ModelV2Schema`. See the [README](../README.md) for usage examples and guides.

For IDE autocomplete, use the JSON Schema at `/schemas/model.v2.json` (served by the infoserver) or generate it locally with `bun run refresh-schema`.

One entry describes one model on one engine, so every number below applies to that exact build. A quantized Ollama build and an fp16 vLLM build of the same model are two entries.

## Required fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name shown in the dashboard model selector |
| `description` | string | Multi-paragraph description shown in the dashboard model selector: purpose, strengths, limitations. Use a YAML block scalar (`description: \|`). A one-line label is not enough, since this is what a user reads to choose between models |
| `url` | URL | External documentation link (e.g. HuggingFace page) |
| `engine` | `"vllm"` \| `"ollama"` | Inference engine this entry runs on |
| `engineSpecifier` | string | The identifier the engine itself uses: a HuggingFace model ID for vLLM (`"meta-llama/Llama-3.1-8B-Instruct"`), a tag for Ollama (`"llama3.1:8b-instruct-fp16"`) |
| `weight` | number | VRAM consumed by this build's weights, in GB |
| `minKvCache` | number | Minimum KV-cache allocation in GB (decimal, 10⁹ - use a decimal, not a rounded integer). It is the floor below which vLLM refuses to start (KV for one request at full context). vLLM reports that floor in GiB, so the field value is `floor_GiB × 1.074`. Confirm it empirically - see "Confirm the KV-cache floor" in [integrating-a-model.md](./integrating-a-model.md) |

## Capabilities

These fields control what the model can do at runtime. Getting them wrong causes request failures.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"chat"` \| `"embedding"` \| `"rerank"` \| `"transcription"` | `"chat"` | Determines which API endpoints accept the model. A rerank request to a chat model is rejected as incompatible |
| `tags` | string[] | `[]` | Enables specific capabilities: `"tools"` (tool/function calling), `"vision"` (image inputs). Requests using a capability the model lacks are rejected. `"tools"` also requires `args: ["--tool-call-parser", "<name>"]` (the daemon adds `--enable-auto-tool-choice` from the tag, but vLLM needs the model-specific parser too). Research and **validate** each capability against a running server before declaring it - see "Validate declared capabilities" in [integrating-a-model.md](./integrating-a-model.md). `"custom_code"` marks models that ship custom loading code requiring vLLM's `--trust-remote-code` flag, and triggers an explicit approval step in the dashboard. Only add if the model fails to load without it |

## Optional fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `family` | string | `"unknown"` | Model family for grouping in the UI (e.g. `"llama"`, `"phi3"`, `"mistral"`) |
| `variantOf` | string | - | Groups this build with the other engine and quantization variants of the same underlying model. The UI presents them together while each stays separately deployable |
| `isCustom` | boolean | `false` | Marks fine-tuned/custom models |
| `entryVersion` | string | - | Minimum xinity-ai version this entry requires. Older clients skip entries they are too old for |
| `maxContextLength` | number | `131072` | Maximum supported context window, in tokens. Used by the gateway to enforce per-model context limits (e.g. in the Responses API) and reported via `GET /v1/models` |
| `args` | string[] | - | Extra CLI arguments appended to the engine's server command. Arrays are deeply flattened to support YAML anchors. Some args are blocked, see below |
| `requestParams` | Record\<string, `"boolean"` \| `"number"` \| `"string"`\> | - | Allowlist of request-level parameters the gateway may forward to the backend. Dot-notation paths (e.g. `top_p`, `repetition_penalty`). Params not listed are dropped |
| `downloadFilter` | string[] | - | Gitignore-style glob patterns appended to the daemon's default HuggingFace download filter. Patterns starting with `!` re-include, and the last matching rule wins. Arrays are deeply flattened to support YAML anchors. Example: `["*.gguf", "!consolidated.safetensors"]` |

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
