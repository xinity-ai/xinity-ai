# Xinity AI Deployment Guide

## Architecture

A Xinity deployment has two distinct roles:

- **Control plane**: runs the gateway, dashboard, database, and Redis. Serves the API and admin UI.
- **Inference node(s)**: each GPU machine runs a daemon alongside Ollama or vLLM. The daemon connects to the shared database to receive deployment instructions and report state.

The control plane can be deployed using any of the three methods below. The daemon is always installed on each inference node using the Xinity CLI, regardless of how the control plane is deployed.

## Choosing a Deployment Method

| Scenario | Recommendation |
|---|---|
| Quick local evaluation, no domain | [Docker Compose (local overlay)](docker/README.md#local-evaluation-no-domain-required) |
| Production with a domain + HTTPS | [Docker Compose](docker/README.md) or [NixOS](nixos/README.md) |
| NixOS infrastructure | [NixOS Flake modules](nixos/README.md) |
| Bare metal Linux with systemd | [Xinity CLI](cli/README.md) |
| Managed Postgres/Redis already available | Any method — point services at your existing database |

## Deployment Guides

| Method | Best for | Guide |
|---|---|---|
| **Xinity CLI** | Any Linux server with systemd | [cli/README.md](cli/README.md) |
| **Docker Compose** | Docker hosts, cloud VMs | [docker/README.md](docker/README.md) |
| **NixOS Flake** | NixOS infrastructure | [nixos/README.md](nixos/README.md) |

---

## Adding Inference Nodes

After the control plane is running (by any method):

1. Install the Xinity CLI on each GPU machine:
   ```bash
   curl -fsSL https://github.com/xinity-ai/xinity-ai/releases/latest/download/install.sh | bash
   ```

2. Run the daemon installer:
   ```bash
   xinity up daemon
   ```

3. When prompted, provide the same `DB_CONNECTION_URL` used by the control plane. The daemon needs direct network access to PostgreSQL.

4. The daemon registers itself in the shared database. It appears in the dashboard and can receive model deployments.

This workflow is the same regardless of whether the control plane runs via Docker, NixOS, or CLI.

---

## Mixing Deployment Methods

A common pattern is Docker Compose for the control plane and the CLI for inference nodes:

- Deploy the control plane with `docker compose up -d` (see [Docker guide](docker/README.md))
- On each GPU machine, install the CLI and run `xinity up daemon`
- The daemon needs network access to PostgreSQL. If PostgreSQL is inside Docker on the control plane host, either:
  - Expose port 5432 on the host (`ports: ["5432:5432"]` in `docker-compose.yml`)
  - Use Docker's host networking mode

NixOS control plane with CLI daemons works the same way — the daemon just needs the database URL.

---

## Secrets

All three deployment targets support the same `_FILE` convention for secrets: for any environment variable `KEY`, you can set `KEY_FILE` to a file path instead. The service reads the file at startup and uses its trimmed contents as the value. Direct environment variables take precedence.

Each target documents this in detail:

- **Docker**: [Secrets Management](docker/README.md#secrets-management) — Docker `secrets:` block with `_FILE` env vars
- **NixOS**: [Secrets: Three Tiers](nixos/README.md#secrets-three-tiers) — direct values, environment file, or per-secret `*File` options
- **CLI**: [Secrets Management](cli/README.md#secrets-management) — systemd `LoadCredential` with mode-600 files in `/etc/xinity-ai/secrets/`
