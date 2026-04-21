# Model field reference

Complete reference for every field in the `ModelSchema`. See the [README](../README.md) for usage examples and guides.

For IDE autocomplete, use the JSON Schema at `/schemas/model.v1.json` (served by the infoserver) or generate it locally with `bun run schema:json`.

## Required fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name shown in the dashboard model selector |
| `description` | string | Brief description of the model's capabilities |
| `weight` | number | VRAM consumed by model weights, in GB |
| `minKvCache` | number | Minimum KV-cache allocation in GB |
| `url` | URL | External documentation link (e.g. HuggingFace page) |
| `providers` | object | Map of driver name to model specifier (see below) |

## Provider specifiers

The `providers` object must contain at least one entry. Keys are driver names, values are the driver-specific model identifier.

| Key | Value | Example |
|-----|-------|---------|
| `vllm` | HuggingFace model ID | `"meta-llama/Llama-3.1-8B-Instruct"` |
| `ollama` | Ollama model tag | `"llama3.1:8b-instruct-fp16"` |

## Capabilities

These fields control what the model can do at runtime. Getting them wrong causes request failures.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"chat"` \| `"embedding"` \| `"rerank"` | `"chat"` | Determines which API endpoints accept the model. A rerank request to a chat model is rejected as incompatible |
| `tags` | string[] | `[]` | Enables specific capabilities: `"tools"` (tool/function calling), `"vision"` (image inputs). Requests using a capability the model lacks are rejected. `"custom_code"` marks models that ship custom loading code requiring vLLM's `--trust-remote-code` flag; triggers an explicit approval step in the dashboard. Only add if the model fails to load without it |

## Optional fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `family` | string | `"unknown"` | Model family for grouping in the UI (e.g. `"llama"`, `"phi3"`, `"mistral"`) |
| `isCustom` | boolean | `false` | Marks fine-tuned/custom models |
| `entryVersion` | string | - | Version of xinity-ai this model was introduced in |

## Per-driver overrides

These fields allow driver-specific configuration. Each is an object with optional `vllm` and `ollama` keys.

| Field | Per-driver type | Description |
|-------|-----------------|-------------|
| `providerTags` | string[] | Replaces model-level `tags` for that driver. Use when a tag only applies to one driver (e.g. `custom_code` on vLLM but not Ollama) |
| `providerArgs` | string[] | Extra CLI arguments appended to the driver's server command. Arrays are deeply flattened to support YAML anchors. Some args are blocked for security |
| `requestParams` | Record\<string, `"boolean"` \| `"number"` \| `"string"`\> | Allowlist of request-level parameters the gateway may forward to the backend. Dot-notation paths (e.g. `top_p`, `repetition_penalty`). Params not listed are dropped |

### Blocked vLLM arguments

These arguments are system-managed and silently stripped from `providerArgs.vllm`:

`--trust-remote-code`, `--enable-auto-tool-choice`, `--runner`, `--task`, `--host`, `--port`, `--served-model-name`, `--kv-cache-memory-bytes`, `--gpu-memory-utilization`, `--api-key`

### Blocked request parameters

These prefixes are never forwarded regardless of `requestParams` configuration:

`chat_template` (CVE-2025-61620), `tokenize` (CVE-2025-62426), `prompt`, `api_key`

## Compatibility constraints

| Field | Per-driver type | Description |
|-------|-----------------|-------------|
| `providerMinVersions` | string (semver) | Minimum driver version required. Nodes with older versions are excluded from scheduling. Example: `vllm: "0.19.1"` |
| `providerPlatforms` | string[] (GPU vendors) | Required GPU vendors. Nodes without a matching GPU are excluded. Values: `"nvidia"`, `"amd"`, `"intel"`. Example: `vllm: [nvidia]` for models with CUDA-only kernels |

When `providerMinVersions` is unset for a driver, any version is accepted. When `providerPlatforms` is unset, any platform is accepted.

## Custom model fields

For fine-tuned models, set `isCustom: true` and provide the `custom` object:

| Field | Type | Description |
|-------|------|-------------|
| `custom.baseModel` | string | Public specifier of the base model this was fine-tuned from |
| `custom.extraFacts` | Record\<string, any\> | Arbitrary metadata about the custom model |

## File-level fields

These appear at the top level of the YAML file, not inside a model definition.

| Field | Type | Description |
|-------|------|-------------|
| `includes` | URL[] | List of remote model source URLs to merge. Local models take precedence over remote includes with the same specifier. Recursive includes are supported with cycle detection |
| `models` | Record\<string, Model\> | Map of public specifier to model definition |
