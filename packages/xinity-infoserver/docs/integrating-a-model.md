# Integrating a model

This guide walks through adding a new model to Xinity by hand: researching it, writing its model
entry, and verifying it actually runs before you publish it. The end product is a `models.yaml`
entry (shape: `ModelSchema`) that you drop into your registry directory. Confirm the entry by
running it, not by reasoning about it.

(The Claude Code `integrate-model` skill points here too, so an agent and a human follow the same
steps.)

## Before you start, read

- [`README.md`](../README.md) - how to write a `models.yaml`, with examples.
- [`docs/model-fields.md`](./model-fields.md) - every field, its default, and the blocked-args list.
- `bun run run-model -- --help` (in `packages/xinity-ai-daemon`) - the runner you verify with.

## Steps

1. **Decide which model.** Resolve it to a concrete source, almost always a HuggingFace repo id
   (e.g. `meta-llama/Llama-3.1-8B-Instruct`). Be specific: base vs instruct, which size, and which
   quantization, since each is a different entry.
2. **Research the fields** (table below) from the HuggingFace model card and the repo's
   `config.json`. Where a value is genuinely unknowable, use the documented default and note it.
3. **Write the entry** as a `models.yaml` fragment. Start with the required fields plus
   `providers.vllm`; add optional fields only when research or a failure justifies them. For editor
   autocomplete and validation, add the schema header from the README's "IDE validation" section.
4. **Verify it runs** (next section), and iterate using the failure table until the gate passes and
   the server comes up healthy.
5. **Publish.** Put the entry in your registry directory (`MODEL_INFO_DIR`). Record which hardware
   you verified it on and any constraints you found (`providerMinVersions`, `providerPlatforms`).

## Researching the fields

| Field | Where it comes from |
|-------|---------------------|
| `providers.vllm` | The HuggingFace repo id. `providers.ollama` only if a matching Ollama tag exists. |
| `weight` | VRAM of the weights in GB. FP16 ≈ params(billions) × 2; quantized (AWQ/GPTQ ~4-bit) ≈ params × 0.5. Round up. |
| `minKvCache` | From `config.json`: roughly `2 × num_hidden_layers × num_key_value_heads × head_dim × dtype_bytes × tokens` (in GB), `tokens` chosen for desired concurrency. If unsure, a small floor like `2` is acceptable; note it as an estimate. |
| `type` | `chat` (default), `embedding`, `rerank`, or `transcription`, from what the model does. |
| `tags` | `vision` if multimodal, `tools` if it supports tool/function calling. Do **not** add `custom_code` preemptively; only after a load failure shows it needs `--trust-remote-code`. |
| `family`, `name`, `description`, `url` | Model card; `url` is the HuggingFace page. |
| `providerMinVersions.vllm` | Set only when the architecture needs a recent vLLM (new model families often do). A `version_too_old` failure is evidence for this. |
| `providerPlatforms.vllm` | Set when the variant needs a specific GPU vendor (e.g. CUDA-only quant kernels → `[nvidia]`). A `wrong_platform` failure is evidence. |
| `providerArgs.vllm` | Extra serve flags (e.g. `["--max-model-len", "8192"]`). Note the blocked-args list in `model-fields.md`; system-managed flags are stripped. |
| `downloadFilter` | Gitignore-style globs to narrow the download (e.g. pick one quant, drop `*.gguf`). |

## Verify it runs

From `packages/xinity-ai-daemon`, point `run-model` at your YAML. It detects the host's hardware,
gates the model against the installed vLLM (version and GPU platform), downloads the weights, and
starts the server, with no daemon, database, or cluster involved:

```bash
# Inspect the plan: what it resolved, whether it can run here, and the exact start command.
bun run run-model -- --models ./models.yaml --model <specifier> --plan

# Run it. Downloads first, then serves; docker if --image is given, otherwise a bare vllm process.
bun run run-model -- --models ./models.yaml --model <specifier> --start
```

The `--plan` output ends with a `Gate:` line: either `ok`, or a reason such as `version_too_old`.
Map failures with the table below. If you are scripting this, add `--json`: it emits the same facts
as a structured object (`{ gate: { ok, reason }, sizing, startCommand, ... }`) and exits non-zero
with an error `code` on failure.

## Failure → fix

| Symptom (gate reason / log) | What it means | Action |
|-----------------------------|---------------|--------|
| `resolution_error` | Entry missing `providers.vllm`, or name not found | Fix the entry / specifier |
| `missing_driver` | No vLLM available on this host | Install vLLM, or pass `--image <vllm-image>` for the docker backend |
| `version_too_old` | Host vLLM older than the model needs | Record the real floor in `providerMinVersions.vllm`; verify on a node that meets it |
| `version_unknown` | Couldn't detect the vLLM version (e.g. docker image not pulled locally) | Pull the image, pass `--vllm-path`, or `--force` to bypass the gate |
| `wrong_platform` | Model needs a GPU vendor this host lacks | Record `providerPlatforms.vllm`; verify on matching hardware |
| `insufficient_capacity` | `weight` + KV-cache exceeds available VRAM | Re-check the `weight` estimate, lower KV-cache via `--kv-cache`, or choose a smaller/quantized variant |
| Server exits at load: "trust_remote_code" / "requires --trust-remote-code" | Model ships custom loading code | Add `custom_code` to `tags` (or `providerTags.vllm`) |
| Server load: unknown/unsupported architecture | vLLM too old for this model | Set `providerMinVersions.vllm` and run on a newer node |
| HF download 401/403 (gated/private repo) | Needs auth | Provide a token via `--hf-token` (or `VLLM_HF_TOKEN`) |
| OOM during load | Too large for the device at this utilization | Lower `--gpu-util` or KV-cache, or pick a smaller variant |

Treat each `providerMinVersions` / `providerPlatforms` / `custom_code` discovery as a **fact about
the model** to bake into the entry, not a one-off workaround. The goal is an entry that the cluster
scheduler can place correctly, which is exactly what these constraints feed (see the README's
"How scheduling uses model data").
