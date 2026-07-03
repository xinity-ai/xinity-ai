# Troubleshooting

## CLI update fails with "Neither ... .tar.gz nor ... .zip found in release"

Starting with v0.21.0, release artifacts are packaged as `.tar.gz` instead of `.zip`. CLI versions older than v0.19.5 do not support `.tar.gz` and will fail when trying to update to a release that only includes `.tar.gz` assets.

To resolve this, reinstall the CLI using the install script:

```bash
curl -fsSL https://github.com/xinity-ai/xinity-ai/releases/latest/download/install.sh | bash
```

This installs the latest CLI, which handles `.tar.gz` assets. After that, `xinity update` works normally again.

If you need to install a specific version:

```bash
curl -fsSL https://github.com/xinity-ai/xinity-ai/releases/latest/download/install.sh | bash -s -- --version v0.21.0
```
