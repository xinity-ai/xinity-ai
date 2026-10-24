# Model catalog

The model entries served by the public registry at `https://sysinfo.xinity.ai`, one entry per
model per engine.

## Layout

Each file sits at `<publisher>/<model-line>.yaml`:

- **Publisher** is the organisation that created the model, as a short lowercase slug (`qwen`,
  `google`, `mistral`). A third-party quantization goes with the model it quantizes, not with
  whoever repacked it.
- **Model line** is one generation of one model line (`qwen3.8`, `gemma-4`, `ornith-1.5`). Every
  size, quantization, engine and text or vision variant of it goes into that one file, so YAML
  anchors can share what the entries have in common.
- **`family`** is the same for every entry in a file and names its model line ("Qwen3.8"). The
  dashboard groups the model picker by it.

A new generation gets a new file next to the old one rather than joining it.

- **Format and field reference**: [packages/xinity-infoserver/README.md](../packages/xinity-infoserver/README.md)
- **Adding a model**: [packages/xinity-infoserver/docs/integrating-a-model.md](../packages/xinity-infoserver/docs/integrating-a-model.md)
- **Requesting a model**: open a [model request](https://github.com/xinity-ai/xinity-ai/issues/new?template=model_request.yml)

CI loads this directory the way the infoserver does, so anything the server could not serve fails
the build. To ask the same question locally:

```bash
cd packages/xinity-infoserver && MODEL_INFO_DIR=../../models bun run server.ts --check
```

Entries are verified by actually running them, not by review alone. The integration guide covers
the `run-model` workflow that does this.

Commits here use the `models` scope, for example `chore(models): add qwen3-vl`.
