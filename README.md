# Xinity AI

[![CI](https://github.com/xinity-ai/xinity-ai/actions/workflows/tests.yml/badge.svg)](https://github.com/xinity-ai/xinity-ai/actions/workflows/tests.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0%20%2F%20ELv2-blue)](#licensing)

Self-hostable AI orchestration platform with an OpenAI-compatible API. Run LLMs on your own infrastructure. No data leaves your environment.

## What it is

Xinity AI is a full model orchestration system. Once deployed, it enables users without deep IT or AI expertise to host cutting edge LLMs, and to fine-tune smaller, more accurate domain models by distilling and/or labeling their own requests.

### The pain it solves

- Enterprises that cannot use AI today due to strict data locality and compliance constraints can run models where their data must stay.
- Reduces dependency on external AI vendors and eliminates the need to send sensitive data to third-party regions or clouds.

### Who it's for

- Enterprises with strict data governance or regulatory requirements.
- Organizations that cannot send sensitive data to third-party AI vendors for legal, regulatory, or policy reasons.
- Teams that need on-prem or data-residency compliant AI deployments.

## Requirements

- Bun >= 1.3 (build, package manager, and runtime)
- Docker + Docker Compose (local dependencies and container builds)
- direnv (recommended for easy env var loading)

## Deployment

See the [Deployment Guide](deployment/README.md) for a full overview, decision tree, and instructions for adding inference nodes.

Three routes are available. The **Xinity CLI** is the recommended starting point for most deployments, handling installation, configuration, and updates interactively.

> **Daemon note:** The daemon must always run on the machine with GPU capacity. Even in Docker or NixOS deployments, the daemon is installed separately on each inference node via the CLI.

| Route | Best for | Guide |
|---|---|---|
| **Xinity CLI** | Any Linux server with systemd | [deployment/cli/README.md](deployment/cli/README.md) |
| **Docker Compose** | Servers with Docker, or cloud VMs | [deployment/docker/README.md](deployment/docker/README.md) |
| **NixOS Flake** | NixOS infrastructure | [deployment/nixos/README.md](deployment/nixos/README.md) |

---

## Quick start (local dev)

```bash
bun install

# Initialize .env files from example.env files (does not overwrite existing .env)
find . -name 'example.env' -not -path '*/node_modules/*' | while read -r f; do
  target="${f%/example.env}/.env"
  [ -f "$target" ] || cp "$f" "$target"
done

# Start local dependencies (Postgres, Redis, Mailhog, and more)
docker compose up -d

# Run DB migrations
cd packages/common-db
bun run migrate
```

From there, start whichever package you want to work on (see Package details below).
The infoserver needs to be running for most packages to work. Start it with `bun run dev` in `packages/xinity-infoserver`.

## Environment variables

- The repo root `example.env` contains shared defaults for database and Redis.
- Some packages also have their own `example.env` files.
- It is usually enough to copy each `example.env` to `.env` and adjust values as needed.

If you use direnv, a minimal per-package `.envrc` can be:

```bash
# .envrc
dotenv
```

Run `direnv allow` in that directory after creating `.envrc`.

## Accessing the system

Once deployed, there are four ways to interact with a running Xinity AI instance. All programmatic access uses **dashboard API keys**, created and managed in the dashboard under **Settings → API Keys**.

### Dashboard UI

The web-based admin interface for day-to-day management: creating and managing model deployments, API keys, applications, organizations, and reviewing recorded LLM calls. Available at the dashboard URL configured during deployment.

### REST API

Every dashboard operation is also available as a REST API, documented live at:

```
https://<your-dashboard>/api/
# or as an openapi schema with:
https://<your-dashboard>/api/openapi.json
```

Authenticate with your dashboard API key:

```bash
curl -H "x-api-key: sk_..." https://<your-dashboard>/api/deployment
```

### MCP Server

The dashboard exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/mcp`, letting AI assistants (Claude Desktop, Cursor, etc.) manage the system directly using natural language. All non-internal API operations are available as MCP tools and stay in sync with the API automatically.

Authenticate using either a bearer token or the `x-api-key` header. Both are equivalent:

```json
{
  "mcpServers": {
    "xinity-ai": {
      "url": "https://<your-dashboard>/mcp",
      "headers": { "Authorization": "Bearer sk_..." }
    }
  }
}
```

```json
{
  "mcpServers": {
    "xinity-ai": {
      "url": "https://<your-dashboard>/mcp",
      "headers": { "x-api-key": "sk_..." }
    }
  }
}
```

The MCP endpoint can be disabled server-side by setting `MCP_ENABLED=false` in the dashboard environment. Individual operations can be excluded from MCP by the system operator using the procedure metadata API (see `packages/xinity-ai-dashboard/CLAUDE.md`).

### Xinity CLI

Install the CLI with a single command:

```bash
curl -fsSL https://github.com/xinity-ai/xinity-ai/releases/latest/download/install.sh | bash
```

This downloads the latest release binary, verifies its checksum, and installs it to `~/.local/bin`. You can pin a version with `--version v1.0.0` or change the install directory with `--prefix /usr/local/bin`. See the [CLI README](packages/xinity-cli/README.md) for all options.

Once installed, the CLI provides commands for installation, configuration, and day-to-day management:

```bash
xinity up all            # install / configure services
xinity doctor            # check system health
xinity act --help        # call dashboard API routes from the terminal
xinity update            # update the CLI itself
```

---

## Repo layout

- `packages/common-db`: shared DB schema, migrations, and tooling
- `packages/xinity-ai-gateway`: API gateway service
- `packages/xinity-ai-dashboard`: SvelteKit admin dashboard
- `packages/xinity-ai-daemon`: model runtime/installation agent (runs on inference hardware)
- `packages/xinity-infoserver`: model metadata schema + YAML server

## Versioning

This monorepo uses lockstep versioning: all packages are released with the same version number.

## Documentation

- Architecture overview: `docs/architecture.md`

## Security

To report a vulnerability, please follow the process in [SECURITY.md](SECURITY.md). Do not open a public issue.

## Contributing

We welcome issues, bug reports, and PRs. Please read `CONTRIBUTING.md` before opening a PR. It outlines scope boundaries, review expectations, and how to propose changes.

## Licensing

This project uses dual licensing:

- **Gateway, daemon, CLI, infoserver, common-db** are licensed under the [Apache License 2.0](LICENSE).
- **Dashboard** (`packages/xinity-ai-dashboard`) is source-available under the [Elastic License 2.0](packages/xinity-ai-dashboard/LICENSE).

The entire codebase is visible and auditable.

## Q&A

**Can I use it for free?**
The gateway, daemon, CLI, infoserver, and database layer are Apache 2.0 licensed and can be used without any restrictions. Only the dashboard requires a license key for larger deployments: the free tier supports one organization and one inference node, which is enough to evaluate the platform or run a small deployment. Paid tiers unlock multiple nodes and organizations, starting with an affordable startup tier (2 nodes), scaling up to enterprise plans (6, 20, or more nodes) with additional features.

**Where does most of the logic live?**
Logic lives in the components responsible for their domain: the dashboard orchestrates system actions, the gateway handles inference requests, and the daemon manages installed models on inference hardware. The database is the shared connection point that allows multiple instances of gateway and daemon to coordinate.

**Can I audit the system?**
Yes. The entire codebase is here and intended to be auditable.

## Common workflows

- Start local dependencies: `docker compose up -d`
- Stop local dependencies: `docker compose down`
- Reset local dependencies (drop volumes/state): `docker compose down -v`
- Regenerate DB migrations (from `packages/common-db`): `bun run migrate:gen`
- Apply DB migrations (from `packages/common-db`): `bun run migrate`
- Inspect DB schema (from `packages/common-db`): `bun run inspect`
- Run system tests (DB + gateway health): `bun run test:system`

## System tests

System tests exercise real DB interactions and service endpoints. They require the dev dependency stack (Postgres + Redis + Mailhog) and a valid `DB_CONNECTION_URL` + `REDIS_URL` in `.env`.

Run them from repo root:

```bash
bun run test:system
```

This script will:

1. Start `db`, `redis`, and `mailhog` via Docker Compose.
2. Run DB migrations from `packages/common-db`.
3. Execute Bun system tests in `tests/system`.

## Docker Compose stacks

`docker compose up -d` starts all local development dependencies:

- `db`: Postgres 17 (port `5432`)
- `redis`: Redis 7 (port `6379`)
- `mailhog`: local SMTP + UI (ports `1025` and `8025`)
- `searxng`: web search (port `6148`)
- `seaweedfs`: S3-compatible object storage (port `8333`)

For a clean slate (fresh database + redis state):

```bash
docker compose down -v
```

### Building images

`docker/build.compose.yaml` exists to make building and tagging the app images locally easy. It is not included in the root `compose.yaml`, so you need to reference it explicitly:

```bash
docker compose -f docker/build.compose.yaml build gateway
docker compose -f docker/build.compose.yaml build dashboard
docker compose -f docker/build.compose.yaml build xinity-infoserver
```

For a full local deployment, see `deployment/docker/`.

## Package details

### Gateway (API)

```bash
cd packages/xinity-ai-gateway
bun run dev
```

### Dashboard (web)

```bash
cd packages/xinity-ai-dashboard
bun run dev
```

### Model info server + schema

This package exports Zod schemas for model metadata and serves them over HTTP. Most other packages depend on it being available at startup.

```bash
cd packages/xinity-infoserver
bun run dev
```

It can also emit JSON schema standalone:

```bash
bun run model.ts
```