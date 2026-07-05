# CLI

The Xinity CLI (`xinity`) is the primary tool for installing, configuring, and managing Xinity services. It operates locally or on remote servers via SSH.

For the full command reference with flags and examples, see the [CLI package README](../../packages/xinity-cli/README.md). For deployment walkthroughs, see the [CLI deployment guide](../../deployment/cli/README.md).

## What it can do

### Install and manage services (`xinity up` / `xinity rm`)

Deploy the full Xinity stack or individual components as systemd units. `xinity up all` runs a guided setup sequence covering database, Redis, infoserver, gateway, dashboard, and optionally the daemon with Ollama. Individual infrastructure utilities (`infra-ollama`, `infra-redis`, `infra-postgres`, `infra-seaweedfs`, `infra-prometheus`) detect, install, and configure dependencies automatically.

`xinity rm` removes installed components, with an optional `--purge` flag to also delete state data.

### Health checking (`xinity doctor`)

Inspects every installed component: binary presence, systemd service status, configuration completeness, database connectivity and migration state, Redis, infoserver reachability, driver availability (Ollama/vLLM), and GPU detection. Outputs in text, JSON, or YAML. Exits with code 1 on any failure.

### API interaction (`xinity act`)

Call any dashboard API route from the command line. Routes are discovered dynamically from the dashboard's oRPC router with full shell completion. When called without data, the CLI generates interactive prompts from the route's input schema. Built-in workflows like `onboarding.cli` combine multiple API calls into guided flows.

### Configuration (`xinity configure`)

Set CLI-level config (API key, dashboard URL) or interactively edit a component's environment file. Configuration is stored in `~/.config/xinity/config.json`.

### Self-update (`xinity update`)

Downloads the latest release, verifies SHA-256, and atomically replaces the binary with rollback on failure. `--check` reports whether an update is available without installing.

### Remote management (`--target-host`)

Every command accepts `--target-host` to operate on a remote server via SSH. Uses ControlMaster multiplexing for session reuse and batches remote checks into single SSH calls for performance. Privilege elevation (sudo) is handled interactively with policy remembered for the session.

### Shell completion (`xinity completion`)

Generates completion scripts for bash, zsh, and fish. Includes dynamic completion of `act` route names from the live dashboard.
