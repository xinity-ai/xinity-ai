# Model Registry (Infoserver)

The infoserver is the model registry for a Xinity cluster. It serves model metadata (not weights) over HTTP so the daemon, gateway, and dashboard know which models exist and how to run them.

The default public registry runs at `https://sysinfo.xinity.ai`. Self-hosting is only needed for custom/private models or air-gapped environments.

For the full guide on writing model definitions and self-hosting, see the [infoserver README](../../packages/xinity-infoserver/README.md). For a complete field reference, see [model-fields.md](../../packages/xinity-infoserver/docs/model-fields.md). For a step-by-step guide on integrating a new model, see [integrating-a-model.md](../../packages/xinity-infoserver/docs/integrating-a-model.md).

## What it provides

### Model catalog

Models are defined in YAML files with metadata including: name, description, VRAM weight, KV-cache requirements, model type (chat, embedding, rerank, transcription), provider-specific identifiers for Ollama and vLLM, capability tags (tools, vision, custom_code), and compatibility constraints (minimum driver versions, GPU vendor requirements).

### Registry composition

A models YAML file can include remote registries via the `includes` directive. Local definitions always take precedence over remote ones. Includes are resolved recursively with cycle detection. The catalog auto-refreshes every 5 minutes.

### HTTP API

The infoserver exposes endpoints for model listing (paginated, filterable by type/family/tag), single model lookup, batch resolution (up to 200 at once), and the full catalog as YAML or JSON. A health endpoint reports model count and last refresh status.

### Node compatibility checking

Before scheduling a model, the system verifies: driver availability, driver version, GPU vendor compatibility, and sufficient VRAM capacity. Version checks are fail-open (missing versions never block scheduling).

### Tag resolution

Capability tags control whether models support tool calling, vision inputs, or custom code execution. Tags can be overridden per-driver via `providerTags`, allowing different capability sets for the same model on Ollama vs. vLLM.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MODEL_INFO_DIR` | (required) | Directory of `*.yaml` model definition files |
| `PORT` | `8090` | HTTP listen port |
| `REFRESH_INTERVAL_MS` | `300000` (5 min) | Re-read interval for model files and remote includes |
| `MAX_INCLUDE_DEPTH` | `10` | Maximum recursion depth for include resolution |
