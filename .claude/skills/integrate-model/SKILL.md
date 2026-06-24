---
name: integrate-model
description: Integrate a new inference model into Xinity from a loose request like "install/integrate/add model X". Researches the model, assembles validated model data (the xinity-infoserver model entry), and verifies it actually runs via the daemon's run-model script, iterating on failures. Use whenever someone wants to make a specific model runnable on the cluster or to produce a model entry they can integrate themselves.
---

# Integrate a model

Follow the canonical procedure in **`packages/xinity-infoserver/docs/integrating-a-model.md`**:
research the model, assemble its model entry, verify it with `run-model`, and iterate on
failures using the failure/fix table. The field reference is in that doc and in
`packages/xinity-infoserver/docs/model-fields.md`.

When working through it as an agent:

- **Write the model entry to a YAML file OUTSIDE this repo** (e.g. `~/modeloutputs/<model>.yaml`) and
  point `run-model --models <that file>` at it for verification. NEVER edit or add to this repo's
  `packages/xinity-infoserver/models.yaml`: model metadata is tracked externally and the integrator
  decides where to apply what you produce. No model-data artifacts may land in this repository.
- Run `run-model` with `--json` (`--plan --json`, then `--start --json`) so output is machine-readable;
  branch on `.gate.reason` and, on error, the non-zero exit with `.code`, instead of scraping text.
- Confirm the entry by actually running it, not by reasoning alone, and that means a real request,
  not just `/health`.
- Research and **validate declared capabilities**: check whether the model supports tool/function
  calling and vision, and if research says it plausibly does, add the tag (tools also needs
  `providerArgs.vllm: ["--tool-call-parser", "<name>"]`) and test it against the running server (a
  real `tool_calls` response; an image description). Skip a test only when research shows no realistic
  chance, and note that you checked.
- Do not add `custom_code` (vLLM `--trust-remote-code`) preemptively; only after a load failure shows it is needed.
- If the model is ambiguous (base vs instruct, size, quantization), ask the user before picking.
