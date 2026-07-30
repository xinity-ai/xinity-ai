# CLI

The Xinity CLI (`xinity`) is the primary tool for installing, configuring, and managing Xinity services. It operates locally or on remote servers via SSH.

For the full command reference with flags and examples, see the [CLI package README](../../packages/xinity-cli/README.md). For deployment walkthroughs, see the [CLI deployment guide](../../deployment/cli/README.md).

## What it can do

### Install and manage services (`xinity up` / `xinity rm`)

Deploy individual components (`gateway`, `dashboard`, `daemon`, `infoserver`, `db`) or a whole machine with `up all`, as systemd units. Every `up` run is plan-based: configuration and versions are collected first without touching the host, the assembled actions are shown with a config diff, and nothing changes until a single confirmation, which can alternatively produce an equivalent bash script. Infrastructure utilities (`infra-ollama`, `infra-redis`, `infra-postgres`, `infra-seaweedfs`, `infra-prometheus`, `infra-searxng`) detect, install, and configure dependencies.

`xinity rm` removes installed components, with an optional `--purge` flag to also delete state data.

### Multi-host deployments (`xinity stack`)

A stack is a local, declarative definition of a whole deployment: shared configuration (database, Redis, metrics auth), stack-wide settings per component type, hosts with their assigned components, and daemon *fleets* (named groups of inference nodes sharing configuration). Configuration is layered so every value lives at the highest level possible; per-host overrides exist but are the escape hatch.

`xinity stack up` compares every host against the definition, plans migrations, installs, updates, reconfigurations, and removal of components the stack no longer tracks, and applies everything after one review gate. A local state file records which hosts the stack manages, so hosts deleted from the definition are evacuated (all managed components removed) on the next `up`. Each stack pins a release version; all components are held at it, re-pinning happens from the release list in `stack edit`, and nothing updates automatically. `xinity stack doctor` (alias `status`) health-checks all hosts, or one fleet via `--fleet`.

Stacks assume the infrastructure underneath (PostgreSQL, Redis) already exists and take its connection URLs as given; the `infra-*` assistants can provision it beforehand. For a guided single-machine install that also provisions infrastructure, `xinity up all` is the intended path.

### Health checking (`xinity doctor`)

Inspects every installed component: binary presence, systemd service status, configuration completeness, database connectivity and migration state, Redis, infoserver reachability, driver availability (Ollama/vLLM), and GPU detection. Outputs in text, JSON, or YAML. Exits with code 1 on any failure.

### API interaction (`xinity act`)

Call any dashboard API route from the command line. Routes are discovered dynamically from the dashboard's oRPC router with full shell completion. When called without data, the CLI generates interactive prompts from the route's input schema. Built-in workflows like `onboarding.cli` combine multiple API calls into guided flows.

### Configuration (`xinity configure`)

Set CLI-level config (API key, dashboard URL) or edit a component's environment through the menu editor. Component changes are reviewed as a diff and applied only after confirmation, followed by a service restart. CLI configuration is stored in `~/.config/xinity/config.json` (`$XDG_CONFIG_HOME` is honored when set).

### Self-update (`xinity update`)

Downloads the latest release, verifies SHA-256, and atomically replaces the binary with rollback on failure. `--check` reports whether an update is available without installing.

### Remote management (`--target-host`)

The single-host commands (`up`, `rm`, `configure`, `doctor`) accept `--target-host` to operate on a remote server via SSH; stacks manage their own host lists. Uses ControlMaster multiplexing for session reuse and batches remote checks into single SSH calls for performance. Root privileges are established once up front (root detected, passwordless sudo auto-detected, otherwise one password prompt per host).

For stacks with many hosts, SSH key-based root login eliminates repeated authentication prompts entirely. Set up an SSH key pair, add the public key to each host's `/root/.ssh/authorized_keys`, and ensure `PermitRootLogin prohibit-password` is set in `/etc/ssh/sshd_config`. With an SSH agent running, even passphrase-protected keys require only one unlock per session regardless of host count. This is the recommended setup for fleet-scale deployments.

### Shell completion (`xinity completion`)

Generates completion scripts for bash, zsh, and fish. Includes dynamic completion of `act` route names from the live dashboard.
