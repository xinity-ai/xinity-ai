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
| `--version` | Print the CLI version |

The single-host commands (`up`, `rm`, `configure`, `doctor`) additionally accept `--target-host <host>` to run against a remote server via SSH. Multi-host operations use stacks (`xinity stack`), which carry their own host lists.

## How Changes Are Applied: Plan → Review → Apply

`xinity up`, `xinity configure`, and `xinity stack up` all follow the same model. No command modifies a machine as it goes; they work in phases:

1. **Collect.** Versions are resolved, current state is read off the host(s), and configuration is gathered through the menu editor (required values are marked and block saving; advanced settings are collapsed behind a toggle). This phase is strictly read-only on the target.
2. **Review.** The assembled actions are shown as a numbered plan: what gets installed, updated, reconfigured, or removed, including the exact configuration diff (`+` added, `~` changed, `-` removed, secret values masked).
3. **Gate.** One confirmation applies everything. Choosing **Abort** leaves the machines untouched. A third, secondary option prints the equivalent bash script instead of running anything, for auditing or manual execution (note: the script contains secrets in plain text).
4. **Apply.** Runs unattended, since root privileges were established when the command started. Updates back up the previous binary and configuration and roll back automatically when the new version fails to start.

`--dry-run` (on `xinity up` and `xinity stack up`) stops after the review, so the plan can be inspected with zero risk.

## Commands

### `xinity up <component>`

Install or update a Xinity service component as a systemd unit, via the plan → review → apply flow described above. `up all` guides through the full sequence (database, Redis, optional infoserver/daemon/Ollama) and carries values declared in earlier steps into the later components, so nothing is asked twice.

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

During `up all`, infrastructure the plan decides to provision (a PostgreSQL container, a Redis install) is only executed after the gate as well; the planning phase never changes machine state.

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
xinity configure gateway              # menu editor for the gateway's environment
xinity configure                      # interactive CLI config menu
```

Component configuration uses the same plan → review → apply flow: the menu editor shows current values (required keys marked, advanced settings collapsed), the review lists only what actually changed as a diff, and nothing is written until the gate is confirmed, after which the service restarts with the new configuration.

**CLI config keys:** `apiKey`, `dashboardUrl`, `githubProjectUrl`, `githubToken`

**Component names:** `gateway`, `dashboard`, `daemon`, `infoserver`

| Flag | Description |
|---|---|
| `--reset` | Clear the specified config key |

Configuration is stored in `$XDG_CONFIG_HOME/xinity/config.json` (mode 0600, directory mode 0700).

### `xinity stack <action>`

Declarative multi-host deployments. A stack is a local definition (`~/.config/xinity/stacks/<name>.json`, mode 600) holding shared configuration, stack-wide settings per component type, hosts (address + components), daemon fleets, and the pinned release version. `stack up` compares every host against the definition and applies only what differs. A separate state file (`$XDG_CONFIG_HOME/xinity/stacks/state/<name>.json`) records which hosts the stack actually manages, so a host deleted from the definition is still torn down on the next `up`.

```bash
xinity stack init prod       # shared + per-component settings, pinned version
xinity stack edit prod       # hosts, fleets, settings, release version
xinity stack up prod         # one plan, one gate, applied across all hosts
xinity stack doctor prod     # health-check every host (alias: status)
```

**Actions:**

| Action | Description |
|---|---|
| `init <name>` | Create a stack: shared settings (database, Redis, metrics auth, ...), then stack-wide settings per component. Required values block saving, so a fresh stack is deployable from the start. |
| `ls` | List stacks |
| `show <name>` | Print a stack summary |
| `edit <name>` | Menu editor for everything in the stack. `--fleet <fleet>` jumps straight to that fleet's daemon settings. |
| `up <name>` | Plan and apply the whole stack at its pinned version. `--target-version <v>` re-pins. |
| `doctor <name>` (alias `status`) | Doctor every host, printing each failing check. `--fleet <fleet>` limits to that fleet's hosts. |
| `rm <name>` | Delete the local stack definition and state; hosts stay untouched. To uninstall components first, remove the hosts from the stack and run `up` before deleting it. Fleets are removed through `stack edit`. |

**Configuration is layered**, most general first, later wins: schema defaults → shared env/secrets → per-component-type settings → fleet overrides (daemon only) → per-host overrides. Values live at the highest level possible; per-host overrides (e.g. `MACHINE_NAME`) are the escape hatch, never the norm. Shared-owned keys are not offered in lower-level editors.

**What `stack up` does**, per host, after one review gate:

- applies database migrations for the pinned release (skipped when the stack already applied them)
- evacuates hosts that were removed from the definition: every managed component is uninstalled and the host is forgotten (unreachable hosts are forgotten without teardown; hosts claimed by another stack are left to it)
- removes components that are installed but no longer tracked by the stack
- installs, updates, or reconfigures each tracked component to match the pinned version and resolved configuration, with the config diff visible in the plan

**Versions are pinned.** Every component in a stack is held at the stack's `pinnedVersion`. The version option in `stack edit` opens a searchable list of the published releases (latest, prereleases, and the current pin marked) to re-pin from, or use `stack up --target-version`. Nothing updates silently.

**Bring your own infrastructure.** Stacks manage Xinity's components, not the infrastructure beneath them: `stack init` takes your PostgreSQL and Redis connection URLs as given (migrations are then run for you). To have the CLI provision that infrastructure first, use the interactive assistants (`xinity up infra-postgres`, `xinity up infra-redis`, with `--target-host` for remote machines) and feed the resulting URLs into the stack. For a guided single-machine setup that can provision everything in one pass, `xinity up all` remains the right tool.

Host addresses are anything ssh accepts (`root@10.0.0.5`, an ssh alias) or `local` for the machine the CLI runs on. A fleet is a named group of daemon hosts sharing configuration overrides, e.g. one pool per GPU type.

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

The single-host commands (`up`, `rm`, `configure`, `doctor`) accept `--target-host`; stacks connect to their hosts on their own. The CLI uses SSH ControlMaster multiplexing to keep a single connection open per host for the session.

Root privileges are established once, up front: connecting as root needs nothing, passwordless sudo is detected automatically, and otherwise the sudo password is asked exactly once per host. Everything afterwards runs unattended.

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
