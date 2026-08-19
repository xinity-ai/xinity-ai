# Integrating a model

This guide walks through adding a new model to Xinity by hand: researching it, writing its model
entry, and verifying it actually runs before you publish it. The end product is an entry (shape:
`ModelSchema`) in a file under `models/`, describing **one model on one engine**. Confirm the
entry by running it, not by reasoning about it.

(The Claude Code `integrate-model` skill points here too, so an agent and a human follow the same
steps.)

## Before you start, read

- [`README.md`](../README.md), the model format with examples.
- [`docs/model-fields.md`](./model-fields.md), every field, its default, and the blocked-args list.
- `bun run run-model -- --help` (in `packages/xinity-ai-daemon`), the runner you verify with.

## Steps

1. **Survey the variants before committing to one.** A model is rarely one artifact, and each
   variant is a separate entry. Finding them after you have written and verified one means doing
   the work again, so spend the ten minutes up front:
   - List the publisher's repos
     (`https://huggingface.co/api/models?author=<org>&search=<name>`) to find every official
     quantization, and look for reputable third-party ones.
   - Read the vendor's vLLM recipe (e.g. `https://recipes.vllm.ai/<org>/<model>`) **end to end**
     and harvest *every* recommendation, not only the one you came for: parser names, quant
     choices, speculative-decoding config, context flags. Recipes routinely name variants you did
     not know existed, and it is wasteful to read one twice.
   - Read `config.json` and `quantization_config` **before downloading anything**. The `ignore` /
     `modules_to_not_convert` list tells you what stayed at full precision, which is usually why a
     "4-bit" checkpoint is nowhere near 4-bit. If speculative decoding is on the table, check for
     `mtp_*` config keys and `mtp.*` tensors in `model.safetensors.index.json`.
   - Grep `models/` for an entry with the same `architectures` value. A sibling on the same
     architecture hands you the KV geometry, the parser names and a version-floor precedent for
     free, and its numbers cross-check yours.

   Then agree the list with whoever asked. Ambiguity about base vs instruct, size or quantization
   is a question to ask, not a guess to make.
2. **Research the fields** (table below) from the HuggingFace model card and the repo's
   `config.json`. Where a value is genuinely unknowable, use the documented default and note it.
3. **Write the entry** into the family's file under `models/`, keyed by a specifier that carries the
   engine (e.g. `qwen3-coder-30b-vllm`). Start with the required fields; add optional fields only
   when research or a failure justifies them. For editor autocomplete and validation, add the schema
   header from the README's "IDE validation" section. Once a family has more than one entry, factor
   the shared values into YAML anchors from the first draft rather than retrofitting them. See
   "Sharing values between entries" below.
4. **Verify it runs** (next section): iterate using the failure table until the gate passes, the
   server comes up, and it **serves a real request** (not just `/health`). Also **validate every
   declared capability**, so test tool calling and vision if research says the model has them. While
   there, pin down the `engineVersions.min` floor by the procedure below, and confirm the derived
   KV-cache floor actually starts.
5. **Write the description last**, once the measurements exist. It is the one field a user reads
   before choosing, so write it for someone deciding between variants: what the model is good at,
   how to prompt it, what it costs, and when to pick a sibling entry instead. Keep the mechanics
   out. Block sizes, tensor counts, kernel names and GiB-vs-GB conversions belong in the PR, not in
   a model picker. Writing this early, from the model card, reliably produces claims you then have
   to correct.
6. **Publish.** Open a PR. In the description, record which hardware you verified it on and any
   constraints you found (`engineVersions.min`, `platforms`). CI loads `models/` the way the server
   does, so a file the server could not serve fails the build.

## Researching the fields

| Field | Where it comes from |
|-------|---------------------|
| `engine`, `engineSpecifier` | `vllm` plus the HuggingFace repo id. An Ollama variant of the same model is a second entry with `engine: ollama` and its own tag, weight and KV floor. |
| `sizing.weightGb` | VRAM the weights actually occupy, in GB. Estimate it to plan the download (FP16 ≈ params(billions) × 2; ~4-bit ≈ params × 0.5), then **replace the estimate with the measured figure** once it loads: vLLM logs `Model loading took X GiB`, and this field is decimal GB, so record `X × 1.074`. Do not sum the safetensors file sizes, which read high (~0.7 GB on a 27B) because not everything on disk becomes resident weight. |
| `sizing.weightBits` | The method's headline width: `torch_dtype` in `config.json` for an unquantized repo, the `quantization_config` bits for AWQ/GPTQ, or the digit in an Ollama tag (`q8_0` → 8, `q4_K_M` → 4). Do not try to work out the real average across the checkpoint: parts of the network stay wider than the headline width, and the field is documented as approximate for exactly that reason. |
| `sizing.activeWeightGb` | MoE only, and only when `config.json` names the sparse layout. Scale `weightGb` by the fraction of parameters active per token, i.e. `num_experts_per_tok / num_experts` over the expert layers, and leave the shared/attention weights counted in full. Omit it for dense models. |
| `sizing.minKvCacheGb` | Leave it out on a plain attention model: `kvBytesPerToken` derives the floor exactly and rounds it up, so authoring both only invites the two to disagree. Author it when you want **more** cache than the floor, or when the derived value is **short of what the engine demands**, which happens legitimately on hybrid and speculative-decoding entries. See "Confirm the KV-cache floor" below. Then confirm it starts. |
| `sizing.kvBytesPerToken` | The `2 × num_hidden_layers × num_key_value_heads × head_dim × dtype_bytes` product from `config.json`, in bytes. The cache floor and the concurrency estimate both come from it, so it is the one KV figure worth getting right. Use the cache dtype the engine will actually run with, which is not always the weight dtype. |
| `sizing.attentionWindow` | `sliding_window` in `config.json`, when the model sets one and does not disable it (`use_sliding_window: false`). Leave it out for full attention. |
| `sizing.stateBytesPerSequence` | Hybrid architectures only, where `config.json` mixes attention with Mamba or gated-deltanet layers (look for `linear_attention`, `mamba` or a `layer_types` list that is not uniformly attention). Sum the per-layer state across the recurrent layers: roughly `conv_state + ssm_state` per layer, i.e. `d_inner × d_conv` plus `d_inner × d_state`, times `dtype_bytes`. Omit it for pure attention models. It is worth confirming against the number vLLM reports for the state cache at startup, because on these models it is what a concurrency cap has to respect. |
| `type` | `chat` (default), `embedding`, `rerank`, or `transcription`, from what the model does. |
| `tags` | `vision` if multimodal, `tools` if it supports tool/function calling. **Research both and validate them** (see "Validate declared capabilities" below). For `tools`, also set `engineArgs: ["--tool-call-parser", "<name>"]`: the tag makes the daemon add `--enable-auto-tool-choice`, but vLLM additionally needs a model-specific parser or it won't start. Registered parser names live in the image under `vllm/tool_parsers/` (e.g. `gemma4`, `lfm2`, `hermes`, `llama3_json`, `mistral`, `pythonic`). Do **not** add `custom_code` preemptively; only after a load failure shows it needs `--trust-remote-code`. |
| `family`, `name`, `url` | Model card; `url` is the HuggingFace page. |
| `sizing.maxContextLength` | `max_position_embeddings` in `config.json`, unless the model card documents a lower supported window. |
| `license` | The model card's license field, then the license text itself. If it is one of the well-known identifiers, name it and you are done (check [model-fields](./model-fields.md) for details). Otherwise read it for limits on **use** (revenue or user thresholds, non-commercial clauses, acceptable-use policies) and write those into `summary`, which is what a user reads before deploying. Do not assume permissive just because the weights are downloadable. |
| `description` | Purpose, strengths, limitations, in your own words. Multiple paragraphs as a block scalar, not a one-line label. Write it **last** (step 5): it is sourced from the model card *and* from what you measured, and it is aimed at a user choosing between variants, not at a maintainer. State what changes for them, meaning which values a parameter takes and what they do, and when to pick a sibling entry. Leave the mechanics to the PR. YAML comments do not reach anyone, so nothing a user needs may live in one. |
| `createdAt` | The day the creator published the model: the initial commit on the HuggingFace repo, or the announcement date the model card cites. Not a later revision, and identical across every engine variant of one model. |
| `registeredAt` | The day you are adding the entry, i.e. today. It records integration, not the model's age, so never copy it from `createdAt` and never backdate it: entries registered in the last 14 days are flagged as new in the dashboard. |
| `engineVersions.min` | Set for new model families / quant formats. Don't guess. **Establish the floor empirically** by running on older vLLM builds until it stops loading ("Confirm the version floor" below). |
| `platforms` | Set when the variant needs a specific GPU vendor (e.g. CUDA-only quant kernels → `[nvidia]`). A `wrong_platform` failure is evidence. |
| `engineArgs` | Extra serve flags (e.g. `["--max-model-len", "8192"]`). Note the blocked-args list in `model-fields.md`; system-managed flags are stripped. Carry a flag only once you can show it does something on **this** architecture. See "Vendor-recommended flags are not all universal". |
| `requestParams` | Allowlist for the **non-standard** request fields this model needs forwarded: `top_k`, `min_p`, `repetition_penalty`, `chat_template_kwargs.*` and the like. Standard OpenAI fields are the gateway's responsibility, so do **not** list one here just because the gateway does not forward it today. An entry states facts about the model; a gap elsewhere in the stack is a bug to fix there, and a workaround encoded here outlives the bug silently and becomes wrong data nobody re-examines. Validate anything you list ("A 200 is not proof" below). |
| `downloadFilter` | Gitignore-style globs to narrow the download (e.g. pick one quant, drop `*.gguf`). |

## Verify it runs

From `packages/xinity-ai-daemon`, point `run-model` at your YAML. It detects the host's hardware,
gates the model against the installed vLLM (version and GPU platform), downloads the weights (on the
host, outside vLLM), and starts the server. No daemon, database or cluster is involved:

```bash
# Inspect the plan: what it resolved, whether it can run here, and the exact start command.
bun run run-model -- --models ../../../models/<family>.yaml --model <specifier> --image <vllm-image> --plan

# Run it. Downloads on the host first, then starts the container.
bun run run-model -- --models ../../../models/<family>.yaml --model <specifier> --image <vllm-image> --start
```

With the docker backend (`--image`), the container always runs **egress-blocked and offline**: it
joins a masquerade-off bridge (published port reachable via DNAT, no outbound internet) with
`HF_HUB_OFFLINE=1`/`TRANSFORMERS_OFFLINE=1`. Weights are pre-downloaded on the host, so the server
never needs the network, and there is deliberately no option to run it with egress. `--start` launches
the container **detached** and prints a `docker logs -f <container>` command to follow the load plus
the stop command, then returns. The container is kept after exit so logs survive a crash. (Base
images whose default command is a shell work too: the runner invokes the vLLM binary via
`--entrypoint`, using `VLLM_PATH` if set, otherwise `vllm` on the image's PATH.)

Because the container is offline, **everything vLLM needs at runtime must be on the host
beforehand**, not just the weights. The downloader fetches the model's own repo; use a per-model
`downloadFilter` to re-include extra files within that repo that it needs (e.g. `*.py` for
`trust_remote_code` / `custom_code` models, whose modeling code would otherwise be missing).
**Known limitation:** an entry that points vLLM at a *second* repo will fail offline. That covers
`--tokenizer <other-repo>` or `--tokenizer-revision` in `engineArgs`, and a `config.json` `auto_map`
pointing elsewhere, because only the model's own repo is pre-downloaded and `downloadFilter` only selects
files within it. Such a model must have that second repo made available offline by other means; the
daemon does not fetch it.

The `--plan` output ends with a `Gate:` line: either `ok`, or a reason such as `version_too_old`.
Map failures with the table below. If you are scripting this, add `--json`: it emits the same facts
as a structured object (`{ gate: { ok, reason }, sizing, startCommand, followLogsCommand, ... }`)
and exits non-zero with an error `code` on failure.

**Tip: check arch support before a big download.** New models can be tens of GB, and `--start`
downloads before it loads, so for an unfamiliar architecture first confirm the image's vLLM even
registers it. Grep the registry inside the image for the `architectures` value from `config.json`:

```bash
docker run --rm --entrypoint sh <vllm-image> -c \
  'P=$(python3 -c "import vllm,os;print(os.path.dirname(vllm.__file__))"); \
   grep -c <ArchFromConfigJson> "$P/model_executor/models/registry.py"'
```

`0` means that build can't load it (treat it like `version_too_old` and try a newer image); a match
means it's worth downloading. Registration is necessary but not sufficient, so still verify by serving.

### One server at a time, and check which one answered

`run-model` publishes on `127.0.0.1:8000`, so only one server runs at a time, and the failure mode
when two collide is silent. It produces wrong answers rather than an error. A container that is still
shutting down, or one from an earlier run whose cleanup never ran (a script killed with `-9` skips
its `trap`), keeps the port. The new `docker run` then fails, but `/health` still answers, and it
answers from the **old** server. Every request after that measures the previous model.

This is worth guarding in any script, because the results look entirely plausible:

- **Before starting**, wait until nothing publishes the port. Checking only your own container name
  does not catch it, since the squatter has a different name:
  `docker ps --format '{{.Ports}}' | grep -q ':8000->'`
- **After `/health`**, assert the server is the one you meant, before believing any result:
  `curl -s localhost:8000/v1/models` and compare the `id` against the entry's `engineSpecifier`.

Treat a self-contradictory result as a symptom of this rather than as a finding. If a flag appears
to have an effect it cannot have, or a defect vanishes without a plausible cause, check what is on
the port before writing anything down.

### Confirm it actually serves (not just `/health`)

A healthy `/health` is not proof, so send a real request and read the output. This catches models that
load but can't serve: a missing chat template (HTTP 400, *"default chat template is no longer
allowed"*), or quantization that loads but emits gibberish (a known failure mode for some FP8 Gemma
variants). For a chat model:

```bash
curl -s localhost:8000/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"<engineSpecifier value>","messages":[{"role":"user","content":"Say OK."}],"max_tokens":10}'
```

The served model name is the `engineSpecifier` value (the HF repo id), not your public specifier.

For a reasoning / chain-of-thought model (e.g. VibeThinker), expect long `<think>`-style output -
a short `max_tokens` will stop it mid-thought with `finish_reason: length`. That's not a failure;
judge the serve check by whether the output is coherent, and give it generous `max_tokens`.

**Third-party requantizations get a harder check than official ones.** A community repack can load
cleanly, answer one prompt correctly, and still emit intermittent empty or single-token responses.
Before publishing one, run a battery of 6-12 varied prompts covering arithmetic, sequence reasoning,
translation, code, time arithmetic and factual recall, and require every one to come back correct
with no empty and no single-token replies. Where the answers are objectively checkable, check them
rather than eyeballing fluency.

### Validate declared capabilities (tools, vision)

Capability tags are **not** optional to verify. During research, determine whether the model supports
**tool/function calling** and **vision (image input)**; if there's a realistic chance it does, add the
tag and **test it against the running server**. Only skip a test when research shows no realistic
chance (e.g. a pure translation model has no tool calling), and note that you checked.

Judge the *model*, not its base or chat template. A model built on a tool-capable base, or whose chat
template can format tool calls, is **not** necessarily tool-capable itself. It must have been
trained/tuned for it. Check the model card for an explicit statement. Example: VibeThinker-3B is built
on Qwen2.5-Coder and the Qwen2 template formats tool calls, yet WeiboAI says it was not trained on
tool calling and don't recommend it, so no `tools` tag. When the card is explicit that it's
unsupported, that counts as "no realistic chance"; don't tag it just because the base could.

**Tools** needs `tags: [tools]` (the daemon adds `--enable-auto-tool-choice`) **and**
`engineArgs: ["--tool-call-parser", "<name>"]` (see the `tags` row above). Send a request with a
`tools` definition and `tool_choice: "auto"`; a working setup returns `finish_reason: tool_calls` and a
structured `tool_calls[]`, not the call buried in `content`:

```bash
curl -s localhost:8000/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model":"<engineSpecifier value>",
  "messages":[{"role":"user","content":"What is the weather in Paris? Use the tool."}],
  "tools":[{"type":"function","function":{"name":"get_weather","description":"Get weather",
    "parameters":{"type":"object","properties":{"location":{"type":"string"}},"required":["location"]}}}],
  "tool_choice":"auto"}' \
  | python3 -c 'import sys,json;c=json.load(sys.stdin)["choices"][0];print(c["finish_reason"], c["message"].get("tool_calls"))'
```

**Vision** needs `tags: [vision]`. Send an image and confirm a relevant description. The container is
egress-blocked, so it can't fetch a remote URL. Pass the image as a `data:` base64 URL:

```bash
curl -s localhost:8000/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model":"<engineSpecifier value>",
  "messages":[{"role":"user","content":[{"type":"text","text":"Describe this image."},
    {"type":"image_url","image_url":{"url":"data:image/png;base64,<...>"}}]}],"max_tokens":50}'
```

A tag whose test fails, or a missing parser, means the entry is wrong. Fix it or drop the tag.

### A 200 is not proof that a parameter did anything

Everything in `requestParams`, and every request-level control the description tells a user to
set, needs the same treatment as a capability tag: show that it changed something. Servers accept
and ignore unknown fields routinely, so `HTTP 200` is not evidence, and neither is a single
side-by-side generation where the difference could be sampling noise.

Two checks that give a real answer:

- **Send a deliberately invalid value.** If the chat template validates the field it raises, and
  the template's error text is distinguishable from the server's own schema error, which also
  tells you *which layer* actually saw the field.
- **Read the rendered prompt.** Asking the model to quote the relevant line of its system prompt
  works when nothing else does. Do **not** use `/tokenize` for this: it does not carry fields like
  `reasoning_effort` and renders the default regardless, so it reports a confident false negative.

Check the model's real accepted values rather than assuming the standard set. A chat template may
accept only a subset and reject the rest with HTTP 400, so a client sending an ordinary OpenAI
value can get an error rather than a result, which is exactly the kind of thing the description
has to warn about. A value the enum allows may also be implemented as *no* instruction rather than
as a distinct level; that can be deliberate design (an unsteered middle setting) rather than a
missing branch, so read the template before calling it broken.

### When a question needs many requests, run them concurrently

Some questions are statistical, such as an intermittent empty completion or a defect that shows up
in a fraction of structured-output replies, and they need tens of requests per configuration. Two things make
the difference between minutes and hours:

- **Send them concurrently.** The server batches happily; a probe that sends one request at a time
  wastes almost all of the card. A dozen workers is a reasonable default.
- **Size `max_tokens` to the symptom, not to the model.** Ask how many tokens the defect actually
  needs to become visible. A malformed JSON *opening* shows up in the first few tokens; a runaway
  string needs the whole budget. Generation here runs on the order of tens of tokens per second, so
  a 2000-token budget on a thinking model is minutes per request, and most of it buys nothing.

A worked case: a serial sweep at `max_tokens: 2000` took ~45 minutes per configuration; the same
question, twelve at a time with the budget cut to what exposed the defect, answered three
configurations in ~5 minutes.

Keep the failing case in the loop as its own bucket. Counting "bad" replies without separating
`finish_reason: length` from a genuine grammar violation will point at the wrong cause. Truncation
at the token cap and a malformed opening look alike in a summary and have nothing in common.

### Vendor-recommended flags are not all universal

A recipe's flag list is written for the vendor's own deployment. Some flags only do something for
certain architectures, or only above tensor-parallel 1, and vLLM will often accept one and
silently do nothing, so an unchecked flag becomes noise in the entry that implies behaviour the
model does not have.

`--mm-encoder-tp-mode data` is the worked example: it applies only to models whose vLLM
implementation sets `supports_encoder_tp_data` (it defaults to `False`, and relatively few
architectures opt in). Confirm support in the image before carrying it:

```bash
docker run --rm --entrypoint sh <vllm-image> -c \
  'P=$(python3 -c "import vllm,os;print(os.path.dirname(vllm.__file__))"); \
   grep -c supports_encoder_tp_data "$P/model_executor/models/<arch_file>.py"'
```

`0` means vLLM downgrades it and logs `Falling back to ...`; leave the flag out. When you do check
a log for a fallback, match on a distinctive substring and case-insensitively, because a grep that misses
is indistinguishable from a flag that worked.

### `maxContextLength` is not passed to the engine

Nothing derives `--max-model-len` from `maxContextLength`. The daemon manages
`--kv-cache-memory-bytes`, `--gpu-memory-utilization`, `--runner`, `--enable-auto-tool-choice` and
`--max-num-seqs`, and leaves the context window to vLLM, which reads it from the model's own
config. That is a deliberate choice rather than an oversight: for most entries the two figures are
the same number, so injecting the flag would be a no-op that also overrode any considered value
already sitting in `engineArgs`.

So when you clip a model below its architectural window, write the figure **twice**:
`maxContextLength` for the catalog, and `--max-model-len` in `engineArgs` for the engine. Both
directions fail if you write only one.

- Missing from `engineArgs`: vLLM sizes its cache for the config's larger figure and then refuses
  to start against the smaller floor the entry declares. `qwen3-embedding-4b-vllm` is the worked
  example, where `config.json` allows 40960 and Qwen document 32K.
- Missing from `maxContextLength`: the gateway advertises and admits a window the engine rejects,
  so the failure lands on a user's request rather than at start-up.

`maxContextLength` also drives the derived KV floor, so an entry that clips its context only in
`engineArgs` reserves cache for a window it will never serve, and reads as needing more VRAM than
it does.

### Confirm the KV-cache floor (`minKvCacheGb`)

The floor is the KV cache one request at the model's full context length needs, below which vLLM
refuses to start. Stating `kvBytesPerToken` computes it, so this section is a check rather than a
hunt: `--start` the entry and confirm it comes up. The log shows
`Maximum concurrency for N tokens per request: 1.00x` when the allocation sits right at the floor.

If it aborts, vLLM names the figure it wanted: `To serve at least one request with the model's max
seq len (N), X GiB KV cache is needed`. That is **GiB** (binary) against our decimal GB, so compare
it as `X × 1.074`. Usually a derived value below what vLLM asks for means `kvBytesPerToken` is
wrong, and it is the field to fix. `minKvCacheGb` remains the *minimum*, and a deployment can
allocate more.

**Exception: hybrid models block-align, and the derived floor is then legitimately short.** On a
model that mixes attention with recurrent layers, vLLM raises the attention block size until an
attention page is at least a mamba page, then pads the mamba page to match. It logs both:

```
Setting attention block size to 784 tokens to ensure that attention page size is >= mamba page size.
Padding mamba page size by 0.13% to ensure that mamba page size and attention page size are exactly equal.
```

That rounds `max_model_len` up to a whole number of blocks, so the true floor sits above what
`kvBytesPerToken × max_model_len + stateBytesPerSequence` derives, by a few hundredths of a GB
which is enough for vLLM to refuse to start. Do **not** inflate `kvBytesPerToken` to compensate: it
is physically correct and it feeds the concurrency estimate. Take the block size and padding from
those two log lines and compute the real requirement:

```
ceil(max_model_len / blk) × (blk × kv_heads × head_dim × 2 × dtype_bytes) × n_full_attn_layers
  + padded_page × n_recurrent_layers
```

then author `minKvCacheGb` **alongside** `kvBytesPerToken`, at the ceiling of that in decimal GB.
Getting the arithmetic to reproduce vLLM's `X GiB is needed` exactly is how you know the number is
right rather than merely large enough, and it lets you predict which values fail, which is worth
confirming with one run at the value just below.

**Speculative decoding raises the floor too.** An MTP or draft head is an extra decoder layer with
its own KV, so an entry enabling `--speculative-config` needs both a higher `minKvCacheGb` and a
higher `weightGb` than the same checkpoint without it. Measure both; do not inherit the base
entry's numbers. Choose `num_speculative_tokens` by measuring throughput at more than one value
instead of copying the recipe: vLLM logs per-position draft acceptance, and the benefit flattens
once acceptance at the last position drops off.

The floor scales with the model's `max_model_len`, and per-request KV is independent of parameter
count, so a *small* model with a *huge* native context can have a surprisingly large floor (e.g.
Hunyuan MT2 **1.8B** at its native **256K** context needs **16 GiB** of KV). When that floor is
impractical for the model's size, cap the context with `engineArgs: ["--max-model-len", "N"]`;
the floor drops roughly proportionally. A useful pattern is to publish **several entries of the same
model at different `--max-model-len` caps**, each one a context/footprint trade-off (shorter context →
smaller floor → more requests fit in the same cache). Note: for models with sliding-window or hybrid
attention (e.g. Gemma 4), the real floor is well below the dense formula above, so trust the
empirical `X GiB needed` figure rather than the estimate.

### Confirm the version floor (`engineVersions.min`)

Don't guess the floor. Establish it by running on the oldest vLLM you intend to support. Using the
image assortment below, `--start` against progressively older versions and, on each, **send a real
request and check the response**. Set `engineVersions.min` to the oldest version that *serves a
correct response*, not merely the oldest that loads. Loading is not proof: a version can start
cleanly (quant kernels selected, `/health` 200) yet **500 on the first request**, for example an
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
| `vllm/vllm-openai:v<X.Y.Z>` | Official (vLLM project) | Version-pinned, and the canonical way to test a specific vLLM version. x86_64; `:cu130-nightly` is the CUDA-13 track for the newest GPUs (nightly tags move, so pin a digest). |
| `nvcr.io/nvidia/vllm:<tag>` | Official (NVIDIA NGC) | Trustworthy, but typically lags upstream by several releases. |
| `timothystewart6/vllm-gb10:v<X.Y.Z>-gb10.N` | Community (TechnoTim) | Built natively for DGX Spark / GB10 (sm_121, arm64). Reproducible builds (GitHub Actions + a verify-reproducible workflow), immutable version tags and a public Dockerfile, which is unusually auditable for a community image. It is still third-party, so review it and pin by digest. Handy for bisecting the version floor on GB10 across vLLM `0.20`-`0.23` (tags e.g. `v0.20.1-gb10.0`, `v0.21.0-gb10.0`, `v0.23.0-gb10.0`, `latest`). |

## Sharing values between entries

A family usually ends up with several entries that differ in only a few fields, and duplicating the
rest makes the real differences hard to see. Factor the shared values into YAML anchors as soon as
there is a second entry, in a top-level block: `ModelFileSchema` is a non-strict object, so a key
it does not know is dropped on load and the anchors resolve at parse time.

```yaml
x-shared:
  identity: &identity
    license: apache-2.0
    engine: vllm
    type: chat
    family: qwen3
    engineVersions:
      min: "0.19.2"
  args: &args
    - --tool-call-parser
    - qwen3_coder

models:
  some-model-vllm:
    <<: *identity
    engineArgs: *args
    # ...
  some-model-variant-vllm:
    <<: *identity
    engineArgs:            # engineArgs is deeply flattened, so the shared list composes
      - *args
      - --language-model-only
```

`engineArgs` and `downloadFilter` are deeply flattened for exactly this reason, so a variant can
nest the shared list and append to it. Merge keys let an entry override a shared value by stating
it explicitly (a variant with a different `minKvCacheGb`, say). Confirm the result with
`--plan --json` and read the emitted `startCommand`: that is the flag list the engine will actually
receive.

## Failure → fix

| Symptom (gate reason / log) | What it means | Action |
|-----------------------------|---------------|--------|
| `resolution_error` | Entry missing `engineSpecifier`, or name not found | Fix the entry / specifier |
| `missing_driver` | No vLLM available on this host | Install vLLM, or pass `--image <vllm-image>` for the docker backend |
| `version_too_old` | Host vLLM older than the model needs | Record the real floor in `engineVersions.min`; verify on a node that meets it |
| `version_unknown` | Couldn't detect the vLLM version (image not pulled locally, or `vllm --version` failed, since it needs GPU access to run) | Pull the image and ensure a GPU is visible, pass `--vllm-path`, or `--force` to bypass the gate (which then won't enforce `engineVersions.min`) |
| `wrong_platform` | Model needs a GPU vendor this host lacks | Record `platforms`; verify on matching hardware |
| `missing_feature` | Node's vLLM install lacks a Python module a required capability needs (e.g. `transcription` models need `soundfile` for the `audio` feature) | Install the missing dependency into the vLLM environment, or run on a node that has it |
| `insufficient_capacity` | `sizing.weightGb` + KV-cache exceeds available VRAM | Re-check the `weightGb` estimate, lower KV-cache via `--kv-cache`, or choose a smaller/quantized variant |
| Server exits at load: "trust_remote_code" / "requires --trust-remote-code" | Model ships custom loading code | Add `custom_code` to `tags`  |
| Server load: unknown/unsupported architecture | vLLM too old for this model | Set `engineVersions.min` and run on a newer node |
| Server load aborts: `weights not initialized from checkpoint: {visual.*}` | A vision-language architecture shipped as a **text-only** checkpoint (`config.json` `language_model_only: true`, no vision weights), but vLLM built the vision tower | Pass `--language-model-only` in `engineArgs`. The config field is not the switch, the CLI flag is. Not a `custom_code` case. Vision is off, so no `vision` tag |
| Request fails HTTP 400 "default chat template is no longer allowed" | Model ships its chat template as a standalone `chat_template.jinja` and it isn't in the cache | The host downloader keeps `*.jinja` by default; if missing, re-run `--download`. Surfaces only if you `/health`-check but never send a real request. See "Confirm it actually serves" |
| Load aborts on KV cache with `X GiB is needed ... available (Y GiB)` where X is only slightly above Y, on a hybrid model | The derived floor is short because vLLM block-aligned the attention page to the mamba page | Compute the real floor from the block size in the log and author `minKvCacheGb`. Do **not** change `kvBytesPerToken`. See "Confirm the KV-cache floor" |
| Loads but output is gibberish | Quant format/kernel mismatch (e.g. some FP8 Gemma variants) | Try a different quant of the same model (e.g. compressed-tensors instead of ModelOpt FP8), or a newer vLLM |
| Intermittent empty or single-token responses from a community requant | Bad repack; a single-prompt check will miss it | Run the 6-12 prompt battery above; if any come back empty, do not publish the entry |
| Load aborts: `tie_weights` `NotImplementedError` | Quant method can't tie embeddings for a tied-embedding model (e.g. ModelOpt FP8 + Gemma) | Use a compressed-tensors FP8 variant (keeps `lm_head` unquantized) instead |
| HF download 401/403 (gated/private repo) | Needs auth | Provide a token via `--hf-token` (or `VLLM_HF_TOKEN`) |
| OOM during load | Too large for the device at this utilization | Lower `--gpu-util` or KV-cache, or pick a smaller variant |
| `docker run` fails with a port conflict, or results describe a model you are not testing | An earlier container still holds `127.0.0.1:8000`; `/health` answers from it | Wait for the port to clear and assert `/v1/models` names the expected `engineSpecifier` before trusting a result. See "One server at a time" |

Treat each `engineVersions.min` / `platforms` / `custom_code` discovery as a **fact about
the model** to bake into the entry, not a one-off workaround. The goal is an entry that the cluster
scheduler can place correctly, which is exactly what these constraints feed (see the README's
"How scheduling uses model data").

The converse matters just as much: **an entry records what is true of the model, never a
compensation for a gap somewhere else in the stack.** If a standard API parameter does not reach
the engine, or the daemon does not yet emit a flag the model would benefit from, that is a bug in
that component, so report it and fix it there. Encoding the workaround here produces data that
quietly outlives the bug and that nobody thinks to re-examine. Ask of every field: *is this a fact
about the model, or a fact about our current implementation?* Only the first belongs in `models/`.

Finally, be careful what counts as verified. Most of the ways an entry ends up wrong are ways of
believing something on weaker evidence than it seemed at the time: a remembered fact restated
instead of re-checked, an `HTTP 200` read as confirmation, a grep that failed to match, a vendor
recommendation adopted without testing whether it applies, or a probe that was talking to the
wrong server. When a number matters, build a model of
it that predicts what *should* fail, then run that case too. A figure that only ever succeeded has
been observed; a figure whose neighbours were shown to fail has been measured.
