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

## Commands

### `xinity doctor`

Inspect the running system: checks systemd services, Docker containers, database connectivity, service health, and configuration state.

```bash
xinity doctor
xinity doctor --verbose
```

### `xinity up <component>`

Install or update a Xinity service component. Walks through configuration interactively when options have changed.

```bash
xinity up gateway
xinity up dashboard --version 0.6.0
xinity up all
```

Components: `gateway`, `dashboard`, `daemon`, `db`, `all`

### `xinity update`

Update installed Xinity components to the latest version.

```bash
xinity update
xinity update --check    # only check, don't install
```

### `xinity act <route> [data]`

Call a dashboard API route directly. Routes are discovered from the running dashboard's OpenAPI spec and auto-completed via shell completion.

```bash
xinity act --list-routes                              # see all available routes
xinity act deployment.list
xinity act deployment.create '{"name": "llama3"}'
echo '{"name": "test"}' | xinity act organization.create -
xinity act user.getSelf --api-key sk-...
```

### Shell completion

Powered by yargs. The completion script calls back into the CLI binary for dynamic resolution (including `act` route names from the live dashboard). Supports bash, zsh, and fish. The shell is auto-detected from `$SHELL` if omitted.

```bash
# Bash
xinity completion bash >> ~/.bashrc
# or
eval "$(xinity completion bash)"

# Zsh: place in your fpath
xinity completion zsh > ~/.zsh/completions/_xinity
# then ensure fpath includes that directory:
#   fpath=(~/.zsh/completions $fpath)
# For oh-my-zsh:
#   xinity completion zsh > ~/.oh-my-zsh/completions/_xinity

# Fish
xinity completion fish > ~/.config/fish/completions/xinity.fish
```

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
