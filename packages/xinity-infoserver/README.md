# xinity-infoserver

The infoserver is the model registry for a Xinity AI cluster. It serves model metadata (not model weights) over HTTP so that the daemon, gateway, and dashboard know which models exist and how to run them.

**You probably don't need to self-host this.** The default public registry at `https://sysinfo.xinity.ai` is maintained by Xinity and updated with new model definitions. Self-hosting only makes sense if you want to add custom or private models, or run in an air-gapped environment.

## Writing a models.yaml

Models are defined in YAML. Each top-level key under `models` is the model's **public specifier**, which is the identifier users see when deploying.

### Minimal example

```yaml
models:
  my-llama-vllm:
    name: Llama 3.1 8B
    description: General-purpose chat model
    url: https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct
    license: apache-2.0
    engine: vllm
    engineSpecifier: "meta-llama/Llama-3.1-8B-Instruct"
    weight: 8
    minKvCache: 2
    maxContextLength: 131072
```

### Full annotated example

```yaml
models:
  phi-3-vision-vllm:                           # Specifier carries the engine
    name: Phi-3 Vision                         # Display name shown in the dashboard

    # Purpose, strengths, limitations. Read to choose between models, so a
    # one-line label is not enough.
    description: |
      Compact vision-language model that reads images alongside text, tuned for
      document and chart understanding at a size that fits a single mid-range GPU.

      Its 128K context takes a whole document in one request. Noticeably weaker
      than larger VLMs at open-ended visual reasoning, so prefer it for
      extraction and summarisation over analysis.

    url: https://huggingface.co/microsoft/Phi-3-vision-128k-instruct
    license: mit                               # Shorthand for a well-known license, see "Licenses" below

    createdAt: 2024-05-21                      # Day the creator published the model
    registeredAt: 2025-12-03                   # Day this entry was added here, see "Dates" below

    engine: vllm                               # vllm or ollama
    engineSpecifier: "microsoft/Phi-3-vision-128k-instruct"  # HF model id, or an Ollama tag

    weight: 8                                  # VRAM consumed by this build's weights, in GB
    minKvCache: 2                              # Minimum KV-cache allocation in GB
    maxContextLength: 128000                   # Max context window in tokens

    type: chat                                 # chat, embedding, rerank, or transcription
    family: phi3                               # Model family for grouping in the UI
    variantOf: phi-3-vision                    # Optional: groups this build with its other variants
    tags: [vision, custom_code]                # Capabilities this build supports
    isCustom: false                            # Set true for fine-tuned models
    unlisted: false                            # Set true to keep it out of the picker while staying deployable

    # Extra CLI arguments appended to the engine's command line. Args the system
    # manages itself (--host, --port, --trust-remote-code, ...) are stripped out.
    args: ["--max-model-len", "4096"]

    # Allowlist of extra request-level parameters the gateway may forward.
    requestParams:
      template.thinking: boolean

    # Minimum engine version required (semver). Older nodes are excluded.
    minEngineVersion: "0.19.1"

    # GPU vendor requirement. Nodes without a matching GPU are excluded. Use this
    # for models depending on vendor-specific features (e.g. AWQ with CUDA-only kernels).
    platforms: [nvidia]

    entryVersion: 0.23.0                       # Optional: clients older than this skip the entry entirely
```

### Key fields explained

- **`engine`** and **`engineSpecifier`**: which inference engine this entry runs on, and the identifier that engine uses. The engine is part of the model's identity, not a choice made at deploy time. To offer a model on both engines, write two entries.
- **`weight`**: How much VRAM this build's weights consume, in GB. For a 7B parameter model in FP16, roughly 14 GB. A quantized build of the same model is smaller, which is why it belongs in its own entry.
- **`minKvCache`**: The minimum KV-cache allocation in GB. This determines how many concurrent requests the model can handle. Larger values allow more concurrency but consume more VRAM.
- **`type`**: Determines API compatibility. A `"rerank"` model only accepts rerank requests, so sending a chat request to it fails. Defaults to `"chat"`.
- **`tags`**: Enables runtime capabilities. `"tools"` enables function/tool calling, `"vision"` enables image inputs. Requests that use a capability the model doesn't declare are rejected. `"custom_code"` is special: some models ship with custom loading code that vLLM must execute via `--trust-remote-code`. This tag marks that requirement and triggers an explicit approval step in the dashboard before deployment. Only add it if the model fails to load without it.
- **`variantOf`**: Optional grouping key. Entries sharing it are presented together in the UI while each stays separately deployable.
- **`minEngineVersion`**: Semver string. An entry requiring `"0.19.1"` is only scheduled on nodes running that engine version or later.
- **`platforms`**: GPU vendor requirement. `[nvidia]` restricts the entry to NVIDIA nodes.

### Licenses

Every entry states its license, because a user deciding whether to deploy a model needs to know what they are allowed to do with it. For a well-known license, name it and the server fills in the rest:

```yaml
license: apache-2.0
```

Recognised identifiers: `apache-2.0`, `mit`, `bsd-3-clause`, `mpl-2.0`, `gpl-3.0`, `agpl-3.0`, `cc-by-4.0`, `cc-by-sa-4.0`, `cc-by-nc-4.0`.

Anything else is written out in full:

```yaml
license:
  name: Acme Open Weights License 1.0
  url: https://example.com/acme-owl-1.0
  use: conditional
  summary: >
    Free for any use including commercial, below $10M annual revenue. Above that
    requires a commercial agreement with Acme.
```

`use` says how far the license restricts *using* the model, which is the only question the dashboard can answer for a user:

| Value | Meaning | Badge |
|-------|---------|-------|
| `open` | No meaningful limit on use. Apache-2.0, MIT, CC-BY | Plain |
| `conditional` | Commercial use allowed within bounds: revenue or user thresholds, acceptable-use policies, naming requirements | Amber |
| `non-commercial` | Commercial use is not permitted | Red |
| `unknown` | The publisher states no terms | Red |

`summary` is required unless `use` is `open`, so a restricted model cannot be published without a sentence explaining the restriction. Omitting `use` entirely is read as `unknown`, which then demands that sentence too.

This models freedom to use, not obligations on redistribution, so copyleft licenses are `open`: the GPL does not restrict running a model. If a license both restricts use and is unusual enough that the three values misrepresent it, say so in `summary`, which is what a user actually reads.

Adding a value to `use` later is not a breaking change. A client too old to recognise one reads it as `unknown` and shows the summary and the link, rather than dropping the model or claiming it is unrestricted.

### Dates

Every entry carries two dates, both written `YYYY-MM-DD`. The dotted form the catalog used historically (`2026.05.05`) still parses and is normalized before it reaches a consumer.

```yaml
createdAt: 2024-05-21     # The creator published the model on this day
registeredAt: 2025-12-03  # It was added to this catalog on this day
```

They answer different questions and are easy to confuse. `createdAt` is a fact about the model, taken from its creator, and it is the same across every engine and quantization variant of one model. It is required because recency is one of the few capability signals a user has when comparing two models they know nothing else about.

`registeredAt` is a fact about this catalog. A model published two years ago and integrated today is newly registered, not new. The dashboard flags entries registered within the last 14 days, so backdating one hides it and postdating one leaves the flag up past its welcome. Adding a variant of an already-integrated model dates only the new entry.

### IDE validation

Add this comment as the first line of your YAML file to get autocomplete and validation in editors that support the YAML Language Server (VS Code, JetBrains):

```yaml
# yaml-language-server: $schema=https://sysinfo.xinity.ai/schemas/model.v2.json
```

Or generate the schemas locally (writes `models.v2.schema.json` and the deprecated `models.schema.json`):

```bash
bun run refresh-schema
```

## Trying a model on a node before publishing

Before adding a model to the registry, you can verify the definition actually runs on a
target machine with the daemon's `run-model` script. It reads the same model YAML, detects
the host's hardware, gates on the installed vLLM version/platform, downloads the weights, and
starts the server, all without a daemon, database, or cluster:

```bash
cd packages/xinity-ai-daemon
# Inspect what would happen (no side effects); --json for machine-readable output
bun run run-model -- --models ./your-models.yaml --model my-private-model --image <vllm-image> --plan
# Resolve files, gate, and start it (docker if --image is given, else a bare vllm process)
bun run run-model -- --models ./your-models.yaml --model my-private-model --image <vllm-image> --start
```

With the docker backend the container always runs egress-blocked and offline (weights are
pre-downloaded on the host first), and `--start` runs it detached, printing a `docker logs -f`
command to follow the load and the stop command. The `--plan` gate result tells you whether
`weight`, `minKvCache`, `minEngineVersion`, and `platforms` are consistent with the
hardware, so you can correct the definition before it ever reaches the cluster scheduler. See
`run-model --help` for the full flag list.

For the full end-to-end workflow (researching the fields, writing the entry, and iterating on
failures), follow the step-by-step guide in [docs/integrating-a-model.md](docs/integrating-a-model.md).

## Composing registries with `includes`

Your models.yaml can include other registries. This lets you extend the public catalog with your own models without having to maintain a copy of the full list.

```yaml
includes:
  - https://sysinfo.xinity.ai/models/v2.json

models:
  my-private-model-vllm:
    name: Internal Fine-tuned LLM
    # ... your model definition
```

An included source has to use the same format as the file including it.

Models from included sources are merged. Local models take precedence over remote includes with the same specifier. Recursive includes are supported with cycle detection.

## Self-hosting

Most deployments use the public registry and don't need this section. Self-host when you need custom models, private model metadata, or air-gapped operation.

### Docker

```bash
docker run -d \
  -v /path/to/models.d:/data/models.d:ro \
  -e MODEL_INFO_DIR=/data/models.d \
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

Or via the CLI, which opens an interactive menu editor for the component's environment (there's no non-interactive one-shot form):

```bash
xinity configure daemon
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

## Upgrading from the pre-v2 model format

Entries used to declare several engines at once through per-engine maps (`providers`,
`providerTags`, ...). That format is deprecated and will be removed before 1.0.0.

Move those files out of `MODEL_INFO_DIR` into a directory of their own and point
`MODEL_LEGACY_DIR` at it. They keep being served on the v1 endpoints unchanged, so running
deployments keep resolving. The two directories never mix and nothing is translated between them.

## API endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (per-catalog model count, last refresh time, last error) |
| `/version.json` | GET | Server version info |
| `/models/v2.json` | GET | The whole catalog, `ETag`-validated. Also what an `includes` entry points at |
| `/models/v2.digest.json` | GET | Content digest alone, for cheap change polling |
| `/schemas/model.v2.json` | GET | JSON Schema for model file validation |

There is no per-model or paginated v2 endpoint. Clients hold the catalog and resolve locally, which
is one conditional request per refresh interval instead of one per lookup, and means every lookup in
a window sees the same generation of the data. `/models/v2.digest.json` is the cheap way to ask
whether that generation changed: it sits on a looser rate limit than the catalog itself, which a
conditional GET cannot, since it shares a URL with the full fetch.

Every endpoint below serves `MODEL_LEGACY_DIR` only, carries a `Deprecation` header, and is
removed before 1.0.0.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/models` | GET | Paginated model list (query: `page`, `pageSize`, `type`, `family`, `tag`) |
| `/api/v1/models/:specifier` | GET | Single model lookup |
| `/api/v1/models/family/:family` | GET | All models in a family |
| `/api/v1/models/resolve` | POST | Batch resolve specifiers (max 200) |
| `/models/v1.yaml` | GET | Raw merged YAML |
| `/models/v1.json` | GET | Raw merged JSON |
| `/schemas/model.v1.json` | GET | JSON Schema for the deprecated format |

Full-catalog exports are rate limited per client (see `RATE_LIMIT_*`) and answer conditional
requests with `304`, so a client that keeps its `ETag` polls cheaply.

## How scheduling uses model data

When a model deployment is created, the scheduler checks each cluster node against the model's requirements:

1. **Driver**: Does the node run the entry's `engine`?
2. **Driver version**: Does the driver version satisfy `minEngineVersion`? (Nodes that haven't reported a version are not excluded.)
3. **GPU platform**: Does at least one of the node's GPUs match `platforms`? (Nodes with no GPUs are excluded when a platform is required.)
4. **Capacity**: Does the node have enough free VRAM for the model's `weight` + KV-cache?

All four checks must pass on a single node. If no node qualifies, the model stays in "scheduling" state and the dashboard shows why it can't be placed.

## Development

Run the HTTP server locally:

```bash
MODEL_INFO_DIR=./models.d bun run dev
```

Regenerate the JSON Schemas:

```bash
bun run refresh-schema
```
