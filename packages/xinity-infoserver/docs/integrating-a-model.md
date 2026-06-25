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
4. **Verify it runs** (next section): iterate using the failure table until the gate passes, the
   server comes up, and it **serves a real request** (not just `/health`). Also **validate every
   declared capability** - test tool calling and vision if research says the model has them. While
   there, pin down the two values you can't reliably guess - the `minKvCache` floor and the
   `providerMinVersions.vllm` floor - by the procedures below.
5. **Publish.** Put the entry in your registry directory (`MODEL_INFO_DIR`). Record which hardware
   you verified it on and any constraints you found (`providerMinVersions`, `providerPlatforms`).

## Researching the fields

| Field | Where it comes from |
|-------|---------------------|
| `providers.vllm` | The HuggingFace repo id. `providers.ollama` only if a matching Ollama tag exists. |
| `weight` | VRAM of the weights in GB. FP16 ≈ params(billions) × 2; quantized (AWQ/GPTQ ~4-bit) ≈ params × 0.5. Round up. |
| `minKvCache` | Start from `config.json`: roughly `2 × num_hidden_layers × num_key_value_heads × head_dim × dtype_bytes × tokens` (in GB), `tokens` chosen for desired concurrency. Then **confirm the hard floor empirically** ("Confirm the KV-cache floor" below) - the value must be at or above what vLLM needs to start. |
| `type` | `chat` (default), `embedding`, `rerank`, or `transcription`, from what the model does. |
| `tags` | `vision` if multimodal, `tools` if it supports tool/function calling - **research both and validate them** (see "Validate declared capabilities" below). For `tools`, also set `providerArgs.vllm: ["--tool-call-parser", "<name>"]`: the tag makes the daemon add `--enable-auto-tool-choice`, but vLLM additionally needs a model-specific parser or it won't start. Registered parser names live in the image under `vllm/tool_parsers/` (e.g. `gemma4`, `lfm2`, `hermes`, `llama3_json`, `mistral`, `pythonic`). Do **not** add `custom_code` preemptively; only after a load failure shows it needs `--trust-remote-code`. |
| `family`, `name`, `description`, `url` | Model card; `url` is the HuggingFace page. |
| `providerMinVersions.vllm` | Set for new model families / quant formats. Don't guess - **establish the floor empirically** by running on older vLLM builds until it stops loading ("Confirm the version floor" below). |
| `providerPlatforms.vllm` | Set when the variant needs a specific GPU vendor (e.g. CUDA-only quant kernels → `[nvidia]`). A `wrong_platform` failure is evidence. |
| `providerArgs.vllm` | Extra serve flags (e.g. `["--max-model-len", "8192"]`). Note the blocked-args list in `model-fields.md`; system-managed flags are stripped. |
| `downloadFilter` | Gitignore-style globs to narrow the download (e.g. pick one quant, drop `*.gguf`). |

## Verify it runs

From `packages/xinity-ai-daemon`, point `run-model` at your YAML. It detects the host's hardware,
gates the model against the installed vLLM (version and GPU platform), downloads the weights (on the
host, outside vLLM), and starts the server - no daemon, database, or cluster involved:

```bash
# Inspect the plan: what it resolved, whether it can run here, and the exact start command.
bun run run-model -- --models ./models.yaml --model <specifier> --image <vllm-image> --plan

# Run it. Downloads on the host first, then starts the container.
bun run run-model -- --models ./models.yaml --model <specifier> --image <vllm-image> --start
```

With the docker backend (`--image`), the container always runs **egress-blocked and offline**: it
joins a masquerade-off bridge (published port reachable via DNAT, no outbound internet) with
`HF_HUB_OFFLINE=1`/`TRANSFORMERS_OFFLINE=1`. Weights are pre-downloaded on the host, so the server
never needs the network - there is deliberately no option to run it with egress. `--start` launches
the container **detached** and prints a `docker logs -f <container>` command to follow the load plus
the stop command, then returns. The container is kept after exit so logs survive a crash. (Base
images whose default command is a shell work too: the runner invokes the vLLM binary via
`--entrypoint`, using `VLLM_PATH` if set, otherwise `vllm` on the image's PATH.)

Because the container is offline, **everything vLLM needs at runtime must be on the host
beforehand**, not just the weights. The downloader fetches the model's own repo; use a per-model
`downloadFilter` to re-include extra files within that repo that it needs (e.g. `*.py` for
`trust_remote_code` / `custom_code` models, whose modeling code would otherwise be missing).
**Known limitation:** an entry that points vLLM at a *second* repo - e.g. `--tokenizer <other-repo>`
(or `--tokenizer-revision`) in `providerArgs`, or a `config.json` `auto_map` to another repo - will
fail offline, because only the model's own repo is pre-downloaded and `downloadFilter` only selects
files within it. Such a model must have that second repo made available offline by other means; the
daemon does not fetch it.

The `--plan` output ends with a `Gate:` line: either `ok`, or a reason such as `version_too_old`.
Map failures with the table below. If you are scripting this, add `--json`: it emits the same facts
as a structured object (`{ gate: { ok, reason }, sizing, startCommand, followLogsCommand, ... }`)
and exits non-zero with an error `code` on failure.

**Tip: check arch support before a big download.** New models can be tens of GB, and `--start`
downloads before it loads - so for an unfamiliar architecture, first confirm the image's vLLM even
registers it. Grep the registry inside the image for the `architectures` value from `config.json`:

```bash
docker run --rm --entrypoint sh <vllm-image> -c \
  'P=$(python3 -c "import vllm,os;print(os.path.dirname(vllm.__file__))"); \
   grep -c <ArchFromConfigJson> "$P/model_executor/models/registry.py"'
```

`0` means that build can't load it (treat like `version_too_old` - try a newer image); a match means
it's worth downloading. Registration is necessary, not sufficient - still verify by serving.

### Confirm it actually serves (not just `/health`)

A healthy `/health` is not proof - send a real request and read the output. This catches models that
load but can't serve: a missing chat template (HTTP 400, *"default chat template is no longer
allowed"*), or quantization that loads but emits gibberish (a known failure mode for some FP8 Gemma
variants). For a chat model:

```bash
curl -s localhost:8000/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"<providers.vllm value>","messages":[{"role":"user","content":"Say OK."}],"max_tokens":10}'
```

The served model name is the `providers.vllm` value (the HF repo id), not your public specifier.

For a reasoning / chain-of-thought model (e.g. VibeThinker), expect long `<think>`-style output -
a short `max_tokens` will stop it mid-thought with `finish_reason: length`. That's not a failure;
judge the serve check by whether the output is coherent, and give it generous `max_tokens`.

### Validate declared capabilities (tools, vision)

Capability tags are **not** optional to verify. During research, determine whether the model supports
**tool/function calling** and **vision (image input)**; if there's a realistic chance it does, add the
tag and **test it against the running server**. Only skip a test when research shows no realistic
chance (e.g. a pure translation model has no tool calling - note that you checked).

Judge the *model*, not its base or chat template. A model built on a tool-capable base, or whose chat
template can format tool calls, is **not** necessarily tool-capable itself - it must have been
trained/tuned for it. Check the model card for an explicit statement. Example: VibeThinker-3B is built
on Qwen2.5-Coder and the Qwen2 template formats tool calls, yet WeiboAI says it was not trained on
tool calling and don't recommend it - so no `tools` tag. When the card is explicit that it's
unsupported, that counts as "no realistic chance"; don't tag it just because the base could.

**Tools** - needs `tags: [tools]` (daemon adds `--enable-auto-tool-choice`) **and**
`providerArgs.vllm: ["--tool-call-parser", "<name>"]` (see the `tags` row above). Send a request with a
`tools` definition and `tool_choice: "auto"`; a working setup returns `finish_reason: tool_calls` and a
structured `tool_calls[]` - not the call buried in `content`:

```bash
curl -s localhost:8000/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model":"<providers.vllm value>",
  "messages":[{"role":"user","content":"What is the weather in Paris? Use the tool."}],
  "tools":[{"type":"function","function":{"name":"get_weather","description":"Get weather",
    "parameters":{"type":"object","properties":{"location":{"type":"string"}},"required":["location"]}}}],
  "tool_choice":"auto"}' \
  | python3 -c 'import sys,json;c=json.load(sys.stdin)["choices"][0];print(c["finish_reason"], c["message"].get("tool_calls"))'
```

**Vision** - needs `tags: [vision]`. Send an image and confirm a relevant description. The container is
egress-blocked, so it can't fetch a remote URL - pass the image as a `data:` base64 URL:

```bash
curl -s localhost:8000/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model":"<providers.vllm value>",
  "messages":[{"role":"user","content":[{"type":"text","text":"Describe this image."},
    {"type":"image_url","image_url":{"url":"data:image/png;base64,<...>"}}]}],"max_tokens":50}'
```

A tag whose test fails (or a missing parser) means the entry is wrong - fix it or drop the tag.

### Confirm the KV-cache floor (`minKvCache`)

`minKvCache` is the floor - the KV cache one request at the model's full context length needs,
below which vLLM refuses to start. It is expressed in **GB** and becomes vLLM's
`--kv-cache-memory-bytes Ng`, where lowercase `g` is **decimal** (10⁹) and accepts decimals - so
write a precise decimal, not a rounded integer. Find the floor empirically: set `minKvCache` low and
`--start`; if it's too small vLLM aborts with `To serve at least one request with the model's max
seq len (N), X GiB KV cache is needed`. That figure is in **GiB** (binary), so the field value is
`X × 1.074` GB (e.g. a 16 GiB floor → `minKvCache: 17.2`). Confirm the chosen value starts - the log
shows `Maximum concurrency for N tokens per request: 1.00x` when it's right at the floor - and that a
smaller value fails. `minKvCache` is the *minimum*; a deployment can allocate more KV for higher
concurrency.

The floor scales with the model's `max_model_len`, and per-request KV is independent of parameter
count - so a *small* model with a *huge* native context can have a surprisingly large floor (e.g.
Hunyuan MT2 **1.8B** at its native **256K** context needs **16 GiB** of KV). When that floor is
impractical for the model's size, cap the context with `providerArgs: vllm: ["--max-model-len", "N"]`;
the floor drops roughly proportionally. A useful pattern is to publish **several entries of the same
model at different `--max-model-len` caps** - each a context/footprint trade-off (shorter context →
smaller floor → more requests fit per GB of KV). Note: for models with sliding-window or hybrid
attention (e.g. Gemma 4), the real floor is well below the dense formula above, so trust the
empirical `X GiB needed` figure rather than the estimate.

### Confirm the version floor (`providerMinVersions.vllm`)

Don't guess the floor - establish it by running on the oldest vLLM you intend to support. Using the
image assortment below, `--start` against progressively older versions and, on each, **send a real
request and check the response**. Set `providerMinVersions.vllm` to the oldest version that *serves a
correct response* - not merely the oldest that loads. Loading is not proof: a version can start
cleanly (quant kernels selected, `/health` 200) yet **500 on the first request** - e.g. an
attention-kernel shape error for the model's head-dim layout. (Real example: Mistral-Small-4 NVFP4
loads on vLLM 0.20.2.dev with NVFP4 kernels selected, but the first request crashes the engine on a
Triton attention shape mismatch; 0.21.0 serves correctly, so 0.21.0 is the floor.) The gate enforces
this only when it can detect the node's vLLM version; detection runs `vllm --version` inside the
image **with GPU access** (without a GPU, `vllm --version` aborts on device inference and the version
reads as unknown). If detection fails, the gate reports `version_unknown` rather than risk an
unverified placement.

### vLLM images to test against

`--image` selects the vLLM build. **Prefer official images**; use community images only where an
official one doesn't yet cover your hardware, and then review the Dockerfile and pin by digest.

| Image | Source | Notes |
|-------|--------|-------|
| `vllm/vllm-openai:v<X.Y.Z>` | Official (vLLM project) | Version-pinned - the canonical way to test a specific vLLM version. x86_64; `:cu130-nightly` is the CUDA-13 track for the newest GPUs (nightly tags move, so pin a digest). |
| `nvcr.io/nvidia/vllm:<tag>` | Official (NVIDIA NGC) | Trustworthy, but typically lags upstream by several releases. |
| `timothystewart6/vllm-gb10:v<X.Y.Z>-gb10.N` | Community (TechnoTim) | Built natively for DGX Spark / GB10 (sm_121, arm64). Reproducible builds (GitHub Actions + a verify-reproducible workflow), immutable version tags, public Dockerfile - unusually auditable for a community image, but still third-party: review it and pin by digest. Handy for bisecting the version floor on GB10 across vLLM `0.20`-`0.23` (tags e.g. `v0.20.1-gb10.0`, `v0.21.0-gb10.0`, `v0.23.0-gb10.0`, `latest`). |

## Failure → fix

| Symptom (gate reason / log) | What it means | Action |
|-----------------------------|---------------|--------|
| `resolution_error` | Entry missing `providers.vllm`, or name not found | Fix the entry / specifier |
| `missing_driver` | No vLLM available on this host | Install vLLM, or pass `--image <vllm-image>` for the docker backend |
| `version_too_old` | Host vLLM older than the model needs | Record the real floor in `providerMinVersions.vllm`; verify on a node that meets it |
| `version_unknown` | Couldn't detect the vLLM version (image not pulled locally, or `vllm --version` failed - it needs GPU access to run) | Pull the image and ensure a GPU is visible, pass `--vllm-path`, or `--force` to bypass the gate (which then won't enforce `providerMinVersions`) |
| `wrong_platform` | Model needs a GPU vendor this host lacks | Record `providerPlatforms.vllm`; verify on matching hardware |
| `insufficient_capacity` | `weight` + KV-cache exceeds available VRAM | Re-check the `weight` estimate, lower KV-cache via `--kv-cache`, or choose a smaller/quantized variant |
| Server exits at load: "trust_remote_code" / "requires --trust-remote-code" | Model ships custom loading code | Add `custom_code` to `tags` (or `providerTags.vllm`) |
| Server load: unknown/unsupported architecture | vLLM too old for this model | Set `providerMinVersions.vllm` and run on a newer node |
| Server load aborts: `weights not initialized from checkpoint: {visual.*}` | A vision-language architecture shipped as a **text-only** checkpoint (`config.json` `language_model_only: true`, no vision weights), but vLLM built the vision tower | Pass `--language-model-only` in `providerArgs.vllm` - the config field is not the switch, the CLI flag is. Not a `custom_code` case. Vision is off, so no `vision` tag |
| Request fails HTTP 400 "default chat template is no longer allowed" | Model ships its chat template as a standalone `chat_template.jinja` and it isn't in the cache | The host downloader keeps `*.jinja` by default; if missing, re-run `--download`. Surfaces only if you `/health`-check but never send a real request - see "Confirm it actually serves" |
| Loads but output is gibberish | Quant format/kernel mismatch (e.g. some FP8 Gemma variants) | Try a different quant of the same model (e.g. compressed-tensors instead of ModelOpt FP8), or a newer vLLM |
| Load aborts: `tie_weights` `NotImplementedError` | Quant method can't tie embeddings for a tied-embedding model (e.g. ModelOpt FP8 + Gemma) | Use a compressed-tensors FP8 build (keeps `lm_head` unquantized) instead |
| HF download 401/403 (gated/private repo) | Needs auth | Provide a token via `--hf-token` (or `VLLM_HF_TOKEN`) |
| OOM during load | Too large for the device at this utilization | Lower `--gpu-util` or KV-cache, or pick a smaller variant |

Treat each `providerMinVersions` / `providerPlatforms` / `custom_code` discovery as a **fact about
the model** to bake into the entry, not a one-off workaround. The goal is an entry that the cluster
scheduler can place correctly, which is exactly what these constraints feed (see the README's
"How scheduling uses model data").
