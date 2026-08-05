# Xinity CLI Deployment

The Xinity CLI is the recommended way to deploy Xinity on any Linux server with systemd. It installs and manages services as systemd units, handles configuration interactively, and keeps everything up to date.

## Prerequisites

- Linux with systemd
- `curl` and `tar`
- For the daemon: a machine with GPU capacity and either Ollama or vLLM available

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

- **Control plane**: runs the gateway, dashboard, tether, and database. Handles API requests, the admin UI, and daemon coordination.
- **Inference node**: runs the daemon with Ollama and/or vLLM available. Has GPU capacity and installs/serves models. Connects to the tether via SSE.

The daemon is always deployed separately on each inference node, regardless of how the control plane is deployed.

## Choosing a Path

- **One machine, batteries included:** `xinity up all` guides you through everything interactively and can provision things like the database for you along the way. Start here if you don't have a database available, dont know how to set up dependencies yourself, or want to run everything on the same machine.
- **Multiple machines, infrastructure already available:** define a stack. It manages all hosts from one declarative definition, but expects a reachable PostgreSQL and Redis to point at. 

## Deploy over Multiple Machines with a Stack (recommended)

For anything beyond a single machine, define a *stack*: a local, declarative description of the whole deployment that the CLI reconciles the machines against.

```bash
xinity stack init prod       # pinned release version, shared settings (database, Redis,
                             # metrics auth), stack-wide settings per component
xinity stack edit prod       # add hosts (e.g. root@10.0.0.4: gateway, dashboard;
                             # root@10.0.0.7: daemon) and group daemons into fleets
xinity stack up prod         # one reviewed plan, then applied host by host
```

`stack up` connects to every host, checks installed versions and configuration against the stack, and plans database migrations, installs, updates, config changes, and removal of components the stack no longer tracks. Hosts deleted from the definition entirely are evacuated too: the CLI keeps a local record of the hosts it manages and removes everything from those that left. Nothing is changed until the plan is confirmed. Re-run it after any edit; it only applies what differs.

Key properties:

- **Layered configuration.** Shared values (like `DB_CONNECTION_URL`) are entered once and inherited everywhere; component-type settings apply stack-wide; fleets carry daemon overrides; per-host overrides exist as the escape hatch.
- **Pinned versions.** The stack holds every component at its pinned release. `stack up` offers available updates and never applies one without an explicit yes.
- **Health checks.** `xinity stack doctor prod` (alias: `status`) runs the doctor on every host and prints each failing check; `--fleet <name>` limits it to one fleet.

Host addresses are anything ssh accepts; use `root@ip` for zero prompts, or a sudo-capable user (one password prompt per host, asked up front).

**Bring your own infrastructure.** A stack deploys and reconciles Xinity's own components; it deliberately does not provision the infrastructure underneath them. `stack init` asks for your PostgreSQL and Redis connection URLs as given facts (migrations are then handled for you). If you need that infrastructure created first, the assistants under `xinity up infra-*` do exactly that, and the URLs they produce go straight into the stack's shared settings.

## Deploy on a Single Machine

For a one-machine setup, `xinity up all` walks through everything in place without a stack definition:

```bash
xinity up all
```

Like every `up` run, this works in phases: configuration is collected first (nothing touches the machine), the planned actions are shown with their config diffs, and only a single confirmation executes them. The same gate can instead print an equivalent bash script for auditing. To install components individually:

```bash
xinity up db          # PostgreSQL migrations + Redis discovery
xinity up gateway     # API gateway
xinity up dashboard   # Admin dashboard
```

## Deploy the Daemon (Inference Node)

Run this on each machine with GPU capacity:

```bash
xinity up daemon
```

The daemon connects to the tether via SSE and receives deployment instructions through it. It needs Ollama or vLLM available on the same machine to actually serve models: `xinity up infra-ollama` installs Ollama and writes the daemon env, or point the daemon at an existing vLLM install with `VLLM_PATH`/`VLLM_DOCKER_IMAGE`.

## Infrastructure Utilities

Infrastructure dependencies are managed with `xinity up infra-<tool>`:

```bash
xinity up infra-ollama      # Install/update ollama, write daemon env
xinity up infra-redis       # Detect/install Redis or Valkey, configure, persist connection URL
xinity up infra-seaweedfs   # Install SeaweedFS S3-compatible object store
xinity up infra-postgres    # Standalone PostgreSQL install/start (without migrations)
```

These commands handle detection, installation, service management, and connectivity testing. They support `--target-host` for remote setup.

## Remote Management

The single-host commands (`up`, `rm`, `configure`, `doctor`) support `--target-host` for managing a remote Linux server over SSH; stacks connect to their hosts on their own:

```bash
xinity up all --target-host user@server
xinity doctor --target-host user@server
xinity configure dashboard --target-host user@server
```

The CLI establishes a persistent SSH connection per host and sets up root privileges once up front (connecting as root needs nothing, passwordless sudo is auto-detected, otherwise one password prompt), so you authenticate at most once regardless of how many elevated operations follow.

## Secrets Management

The CLI automatically separates configuration from secrets. During `xinity up`, it inspects each service's schema and prompts for secrets separately (with masked input).

### How it works

Every environment variable in a service schema is either **config** (non-sensitive) or a **secret** (marked with `.meta(secret())` in the source). The CLI stores them differently:

| Type | Location | Permissions | Loaded via |
|---|---|---|---|
| Config | `/etc/xinity-ai/<component>.env` | `644` (readable) | systemd `EnvironmentFile=` |
| Secrets | `/etc/xinity-ai/secrets/<KEY>` | `600` (root only) | systemd `LoadCredential=` |

At runtime, systemd loads each secret file into an ephemeral credentials directory (`/run/credentials/xinity-ai-<component>/`). The service receives a `KEY_FILE` environment variable pointing to that path and reads the secret from the file. The secret never appears as a plain environment variable in the process environment.

This is the same `_FILE` convention used by the Docker and NixOS deployments, for any variable `KEY`, set `KEY_FILE` to a file path and the service reads it at startup. Direct values take precedence.

### File layout example

After `xinity up gateway`:

```
/etc/xinity-ai/
  gateway.env                    # HOST=localhost, PORT=4010, ...  (mode 644)
  secrets/                       # (mode 700)
    DB_CONNECTION_URL            # postgresql://...               (mode 600)
    REDIS_URL                    # redis://...                    (mode 600)
```

### Reconfiguring

```bash
xinity configure gateway    # menu editor over the gateway's environment
```

The editor shows the current values; on save, a review lists exactly what would change (secrets masked) and nothing is written until confirmed. The service is restarted afterwards to pick up the new configuration.

### Rotating secrets

1. Write the new value: `printf '%s' 'new-value' | sudo tee /etc/xinity-ai/secrets/KEY > /dev/null`
2. Restart: `sudo systemctl restart xinity-ai-<component>`

Or use `xinity configure <component>` to re-run the interactive prompts.

## First-time Setup (Onboarding)

After installation, create your admin account and organization. You can do this entirely from the CLI without opening a browser:

```bash
# Point the CLI at your dashboard
xinity configure dashboardUrl http://your-dashboard-url

# Create your admin account, organization, and API key
xinity act onboarding.cli
```

The onboarding wizard prompts for your name, email, password, and organization name. It creates everything and saves the dashboard API key to your CLI config automatically.

Alternatively, open the dashboard URL in a browser and sign up through the web UI.

Once onboarded, you can manage your instance from the CLI using `xinity act`. Run `xinity act --list-routes` to see all available operations.

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
