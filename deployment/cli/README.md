# Xinity CLI Deployment

The Xinity CLI is the recommended way to deploy Xinity on any Linux server with systemd. It installs and manages services as systemd units, handles configuration interactively, and keeps everything up to date.

## Prerequisites

- Linux with systemd
- `curl` and `unzip`
- For the daemon: a machine with GPU capacity running Ollama

## Install the CLI

```bash
curl -fsSL https://github.com/xinity-ai/xinity-ai/releases/latest/download/install.sh | bash
```

The binary is installed to `~/.local/bin/xinity`. If that directory is not in your `$PATH`, the installer will tell you what to add to your shell profile.

To install a specific version:

```bash
curl -fsSL https://github.com/xinity-ai/xinity-ai/releases/latest/download/install.sh | bash -s -- --version v1.2.0
```

To install to a different location:

```bash
curl -fsSL https://github.com/xinity-ai/xinity-ai/releases/latest/download/install.sh | bash -s -- --prefix /usr/local/bin
```

## Architecture

A Xinity deployment spans two kinds of machines:

- **Control plane**: runs the gateway, dashboard, and database. Handles API requests and the admin UI.
- **Inference node**: runs the daemon alongside Ollama. Has GPU capacity and installs/serves models.

The daemon is always deployed separately on each inference node, regardless of how the control plane is deployed.

## Deploy the Control Plane

Run this on the machine that will serve the API and dashboard:

```bash
xinity up all
```

This installs and configures gateway, dashboard, and the database as systemd services. The CLI walks through required configuration interactively.

To install components individually:

```bash
xinity up db          # PostgreSQL + migrations
xinity up gateway     # API gateway
xinity up dashboard   # Admin dashboard
```

## Deploy the Daemon (Inference Node)

Run this on each machine with GPU capacity:

```bash
xinity up daemon
```

The daemon connects to the shared database and receives deployment instructions from the dashboard. Ollama must be installed and running on the same machine.

## Verify the Deployment

```bash
xinity doctor
```

Checks systemd service states, database connectivity, and service health endpoints. Use `--verbose` for detailed output.

## Updates

```bash
xinity update           # update all components to the latest release
xinity update --check   # check for updates without installing
```

Individual components can also be updated with `xinity up <component>`, which will detect the version change and reconfigure if needed.

## Shell Completion

```bash
# Bash / Zsh
source <(xinity completion)

# Or add to your profile permanently
xinity completion >> ~/.bashrc
```

## Full Command Reference

See [packages/xinity-cli/README.md](../../packages/xinity-cli/README.md) for all available commands and options.
