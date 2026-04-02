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
  gateway.env                    # HOST=0.0.0.0, PORT=4121, ...  (mode 644)
  secrets/                       # (mode 700)
    DB_CONNECTION_URL            # postgresql://...               (mode 600)
    REDIS_URL                    # redis://...                    (mode 600)
```

### Reconfiguring

```bash
xinity configure gateway    # re-prompts for config and secrets
```

The service is automatically restarted after saving to pick up the new configuration.

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
