# Xinity CLI

Command-line interface for managing the Xinity AI platform. Serves as the primary entry point for installing, configuring, and interacting with Xinity services.

## Installation

Download and install the latest release binary:

```bash
curl -fsSL https://github.com/xinity-ai/xinity-ai/releases/latest/download/install.sh | bash
```

The script detects your platform (Linux x64 or arm64), downloads the matching binary, verifies its SHA256 checksum, and installs it to `~/.local/bin`.

### Options

| Flag | Description | Default |
|---|---|---|
| `--version VERSION` | Install a specific release (tag name) | `latest` |
| `--prefix DIR` | Installation directory | `~/.local/bin` |
| `--repo OWNER/REPO` | GitHub repository | `xinity-ai/xinity-ai` |

```bash
# Install a specific version
curl -fsSL https://github.com/xinity-ai/xinity-ai/releases/latest/download/install.sh | bash -s -- --version v1.0.0

# Install to a custom directory
curl -fsSL https://github.com/xinity-ai/xinity-ai/releases/latest/download/install.sh | bash -s -- --prefix /usr/local/bin
```

### Prerequisites

- `unzip` (used to extract the release archive)

### Private repositories

For private or internal forks, the installer needs a GitHub token. Set `GITHUB_TOKEN` in your environment or authenticate with the GitHub CLI (`gh auth login`). Private repo downloads also require `jq` to be installed.

### Updating

Once installed, the CLI can update itself:

```bash
xinity update            # update to the latest version
xinity update --check    # check for updates without installing
```

## Global Options

| Flag | Description |
|---|---|
| `--target-host <host>` | Run the command on a remote server via SSH (any valid ssh host alias or address) |
| `--version` | Print the CLI version |

## Commands

### `xinity up <component>`

Install or update a Xinity service component as a systemd unit. Walks through configuration interactively when options have changed.

```bash
xinity up gateway
xinity up dashboard --target-version 0.6.0
xinity up all
```

**Components:**

| Component | What it installs |
|---|---|
| `gateway` | API gateway service |
| `dashboard` | SvelteKit dashboard service |
| `daemon` | Model runtime agent |
| `infoserver` | Model registry server |
| `db` | Runs database migrations and Redis discovery |
| `infra-ollama` | Detects/installs Ollama and wires the daemon |
| `infra-redis` | Detects/installs Redis or Valkey |
| `infra-postgres` | Provisions PostgreSQL via Docker |
| `infra-seaweedfs` | Downloads and configures SeaweedFS for S3 storage |
| `infra-prometheus` | Provisions Prometheus via Docker with auto-generated scrape config |
| `infra-vllm` | (coming soon) |
| `infra-searxng` | (coming soon) |
| `cli` | Self-update (same as `xinity update`) |
| `all` | Guided setup of the full stack in sequence |

| Flag | Default | Description |
|---|---|---|
| `--target-version` | `latest` | Version tag to install |
| `--dry-run` | `false` | Show what would be done without making changes |
| `--hard-reset` | `false` | Fully reset component state during reinstall |

Core components go through: pre-flight checks, version resolution from GitHub, download with SHA-256 verification, interactive environment configuration, systemd unit generation, service start, and health verification. On updates, the previous binary and config are backed up. On start failure, rollback to the previous version is offered.

### `xinity rm <component>`

Remove an installed service component. Components: `gateway`, `dashboard`, `daemon`, `infoserver`, `all`.

```bash
xinity rm daemon
xinity rm all --purge
```

| Flag | Default | Description |
|---|---|---|
| `--purge` | `false` | Also remove state data (logs, runtime files) |

Prompts for confirmation before removal. For the daemon, also cleans up the `vllm-driver@.service` template unit.

### `xinity doctor`

Inspect the running system and report health status: systemd services, database connectivity, Redis, infoserver, driver availability (Ollama/vLLM), GPU detection, and component health endpoints.

```bash
xinity doctor
xinity doctor --verbose
xinity doctor --format json
```

| Flag | Default | Description |
|---|---|---|
| `--verbose` / `-v` | `false` | Show detailed output for each check |
| `--format` / `-f` | `text` | Output format: `text`, `json`, or `yaml` |
| `--interactive` | `true` | Prompt for sudo when permission-denied checks are encountered |

Exits with code 1 if any checks failed.

### `xinity act <route> [data]`

Call a dashboard API route directly. Routes are discovered from the running dashboard's oRPC router and auto-completed via shell completion.

```bash
xinity act --list-routes                              # see all available routes
xinity act deployment.list
xinity act deployment.create '{"name": "llama3"}'
echo '{"name": "test"}' | xinity act organization.create -
xinity act user.getSelf --api-key sk-...
```

| Flag | Description |
|---|---|
| `--list-routes` | List all available API routes |
| `--api-key` | API key for authentication |
| `--url` | Dashboard URL override |

When called without data, interactive prompts are generated from the route's input schema (enums become select menus, booleans become confirmations, etc.). Data can be piped via stdin with `-`.

**Resolution order for API key:** `--api-key` flag, `XINITY_API_KEY` env var, then `xinity configure apiKey`.

**Resolution order for dashboard URL:** `--url` flag, `XINITY_DASHBOARD_URL` env var, then `xinity configure dashboardUrl`, then `http://localhost:5173`.

### `xinity configure [key] [value]`

Set CLI configuration values or interactively configure a service component's environment.

```bash
xinity configure apiKey sk-...        # set a CLI config value
xinity configure apiKey --reset       # clear a value
xinity configure gateway              # interactive env editor for the gateway
xinity configure                      # interactive CLI config menu
```

**CLI config keys:** `apiKey`, `dashboardUrl`, `githubProjectUrl`, `githubToken`

**Component names:** `gateway`, `dashboard`, `daemon`, `infoserver`

| Flag | Description |
|---|---|
| `--reset` | Clear the specified config key |

Configuration is stored in `~/.config/xinity/config.json` (mode 0600, directory mode 0700).

### `xinity update`

Update the CLI binary to the latest GitHub release.

```bash
xinity update
xinity update --check
```

| Flag | Default | Description |
|---|---|---|
| `--check` | `false` | Only check for updates, do not install |
| `--target-version` | `latest` | Version to update to |

Downloads the correct binary for the platform, verifies the SHA-256 checksum, and atomically replaces the running binary with rollback on failure.

### `xinity completion [shell]`

Generate shell completion scripts. The shell is auto-detected from `$SHELL` if omitted.

```bash
# Bash
xinity completion bash >> ~/.bashrc

# Zsh: place in your fpath
xinity completion zsh > ~/.zsh/completions/_xinity

# Fish
xinity completion fish > ~/.config/fish/completions/xinity.fish
```

## Remote Host Support

All commands accept `--target-host` to operate on a remote server via SSH. The CLI uses SSH ControlMaster multiplexing to keep a single connection open for the session.

Privilege elevation is handled interactively: the CLI auto-detects passwordless sudo, prompts for a sudo password when needed, or offers a manual mode. The elevation policy is remembered for the session.

For the `doctor` command, all remote file and service checks are batched into a single SSH call to minimize round-trips over high-latency connections.

## Development

```bash
# From monorepo root
bun install

# Run directly
bun run packages/xinity-cli/src/index.ts --help
bun run packages/xinity-cli/src/index.ts doctor

# Or from within the package
cd packages/xinity-cli
bun run dev
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `XINITY_DASHBOARD_URL` | Dashboard API endpoint | `http://localhost:5173` |
| `XINITY_API_KEY` | API key for dashboard auth | - |
| `DB_CONNECTION_URL` | PostgreSQL connection URL (for doctor) | - |
