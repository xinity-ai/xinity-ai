# xinity-infoserver

The infoserver is the model registry for a Xinity AI cluster. It serves model metadata (not model weights) over HTTP so that the daemon, gateway, and dashboard know which models exist and how to run them.

**You probably don't need to self-host this.** The default public registry at `https://sysinfo.xinity.ai` is maintained by Xinity and updated with new model definitions. Self-hosting only makes sense if you want to add custom or private models, or run in an air-gapped environment.

## Writing a models.yaml

Models are defined in YAML. Each top-level key under `models` is the model's **public specifier**, which is the identifier users see when deploying.

### Minimal example

```yaml
models:
  my-llama:
    name: Llama 3.1 8B
    description: General-purpose chat model
    weight: 8
    minKvCache: 2
    url: https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct
    providers:
      vllm: "meta-llama/Llama-3.1-8B-Instruct"
```

### Full annotated example

```yaml
models:
  my-vision-model:
    name: Phi-3 Vision                        # Display name shown in the dashboard
    description: | 
      Lightweight vision model      
      # Brief description of capabilities
    weight: 8                                  # Model size in GB (VRAM consumed by weights)
    minKvCache: 2                              # Minimum KV-cache allocation in GB
    url: https://huggingface.co/microsoft/Phi-3-vision-128k-instruct
    entryVersion: 0.5.4                        # Optional: xinity version this model was introduced in
    type: chat                                 # chat, embedding, or rerank - determines API compatibility
    family: phi3                               # Model family for grouping in the UI
    tags: [vision]                             # Enabled capabilities: tools, vision, custom_code
    isCustom: false                            # Set true for fine-tuned models

    # Provider specifiers: at least one required.
    # The value is the driver-specific model identifier.
    providers:
      vllm: "microsoft/Phi-3-vision-128k-instruct"   # HuggingFace model ID for vLLM
      ollama: "phi3:vision"                           # Ollama model tag

    # Per-driver tag overrides. When set, replaces model-level tags for that driver.
    providerTags:
      vllm: [custom_code, vision]

    # Per-driver CLI arguments appended to the server command line.
    # Certain args are blocked for security (--trust-remote-code, --host, etc.)
    providerArgs:
      vllm: ["--max-model-len", "4096"]

    # Per-driver request parameter allowlist. Only listed params are forwarded.
    requestParams:
      vllm:
        template.thinking: boolean

    # Minimum driver version required (semver). Nodes with older versions are excluded.
    providerMinVersions:
      vllm: "0.19.1"

    # GPU platform requirements. Nodes without a matching GPU vendor are excluded.
    # Use this for models that depend on vendor-specific hardware features
    # (e.g., AWQ quantization with CUDA-only kernels).
    providerPlatforms:
      vllm: [nvidia]
```

### Key fields explained

- **`weight`**: How much VRAM the model weights consume, in GB. For a 7B parameter model in FP16, this is roughly 14 GB. For quantized models, it's smaller.
- **`minKvCache`**: The minimum KV-cache allocation in GB. This determines how many concurrent requests the model can handle. Larger values allow more concurrency but consume more VRAM.
- **`type`**: Determines API compatibility. A `"rerank"` model only accepts rerank requests; sending a chat request to it fails. Defaults to `"chat"`.
- **`tags`**: Enables runtime capabilities. `"tools"` enables function/tool calling, `"vision"` enables image inputs. Requests that use a capability the model doesn't declare are rejected. `"custom_code"` is special: some models ship with custom loading code that vLLM must execute via `--trust-remote-code`. This tag marks that requirement and triggers an explicit approval step in the dashboard before deployment. Only add it if the model fails to load without it.
- **`providers`**: Maps driver names to their model specifiers. For vLLM, this is typically a HuggingFace model ID. For Ollama, it's an Ollama model tag. At least one provider must be specified.
- **`providerMinVersions`**: Semver version strings. A model requiring `vllm: "0.19.1"` will only be scheduled on nodes running vLLM 0.19.1 or later.
- **`providerPlatforms`**: GPU vendor requirements. A model with `vllm: [nvidia]` will only run on nodes with NVIDIA GPUs. Useful for models that depend on vendor-specific features (e.g., AWQ with CUDA-only kernels).

For the complete field reference, see [docs/model-fields.md](docs/model-fields.md).

### IDE validation

Add this comment as the first line of your YAML file to get autocomplete and validation in editors that support the YAML Language Server (VS Code, JetBrains):

```yaml
# yaml-language-server: $schema=https://sysinfo.xinity.ai/schemas/model.v1.json
```

Or generate the schema locally:

```bash
bun run schema:json > models.schema.json
```

## Composing registries with `includes`

Your models.yaml can include other registries. This lets you extend the public catalog with your own models without having to maintain a copy of the full list.

```yaml
includes:
  - https://sysinfo.xinity.ai/models/v1.json

models:
  my-private-model:
    name: Internal Fine-tuned LLM
    # ... your model definition
```

Models from included sources are merged. If the same specifier appears in multiple sources, later entries override earlier ones. Recursive includes are supported with cycle detection.

## Self-hosting

Most deployments use the public registry and don't need this section. Self-host when you need custom models, private model metadata, or air-gapped operation.

### Docker

```bash
docker run -d \
  -v /path/to/your/models.yaml:/data/models.yaml:ro \
  -e MODEL_INFO_FILE=/data/models.yaml \
  -e PORT=8090 \
  -p 8090:8090 \
  ghcr.io/xinity-ai/xinity-infoserver:latest
```

### Pointing the cluster at your registry

Set `INFOSERVER_URL` on each component that needs model metadata:

| Component  | Config file              | Variable         |
|------------|--------------------------|------------------|
| Daemon     | `/etc/xinity-ai/daemon.env`    | `INFOSERVER_URL` |
| Gateway    | `/etc/xinity-ai/gateway.env`   | `INFOSERVER_URL` |
| Dashboard  | `/etc/xinity-ai/dashboard.env` | `INFOSERVER_URL` |

Or via the CLI:

```bash
xinity configure daemon INFOSERVER_URL http://your-infoserver:8090
```

### Verifying

```bash
# Health check
curl http://localhost:8090/health

# List all models
curl http://localhost:8090/api/v1/models

# Fetch a specific model
curl http://localhost:8090/api/v1/models/my-private-model
```

## API endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/version.json` | GET | Server version info |
| `/api/v1/models` | GET | Paginated model list (query: `page`, `pageSize`, `type`, `family`, `tag`) |
| `/api/v1/models/:specifier` | GET | Single model lookup |
| `/api/v1/models/family/:family` | GET | All models in a family |
| `/api/v1/models/resolve` | POST | Batch resolve specifiers (max 200) |
| `/models/v1.yaml` | GET | Raw merged YAML |
| `/models/v1.json` | GET | Raw merged JSON |
| `/schemas/model.v1.json` | GET | JSON Schema for model file validation |

## How scheduling uses model data

When a model deployment is created, the scheduler checks each cluster node against the model's requirements:

1. **Driver**: Does the node have the right inference driver (vLLM or Ollama)?
2. **Driver version**: Does the driver version satisfy `providerMinVersions`? (Nodes that haven't reported a version are not excluded.)
3. **GPU platform**: Does at least one of the node's GPUs match `providerPlatforms`? (Nodes with no GPUs are excluded when a platform is required.)
4. **Capacity**: Does the node have enough free VRAM for the model's `weight` + KV-cache?

All four checks must pass on a single node. If no node qualifies, the model stays in "scheduling" state and the dashboard shows why it can't be placed.

## Development

Run the HTTP server locally:

```bash
MODEL_INFO_FILE=./models.yaml bun run start
```

Export the JSON Schema to stdout:

```bash
bun run schema:json
```
