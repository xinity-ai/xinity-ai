# Model catalog

The model entries served by the public registry at `https://sysinfo.xinity.ai`. One file per
family, one entry per model per engine.

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
