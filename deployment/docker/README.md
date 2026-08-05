# Xinity AI Docker Compose Deployment

Single Compose file that brings up the full Xinity control plane (gateway, dashboard, tether, and supporting infrastructure). Two modes:

- **Localhost evaluation** (default): `docker compose up -d`. Gateway and dashboard reachable on `127.0.0.1:4121` and `127.0.0.1:5121`. No domain or TLS needed.
- **HTTPS deployment**: `docker compose --profile caddy up -d`. Caddy fronts the stack with Let's Encrypt certificates on a real domain.

Optional services live behind their own profiles:

- `--profile searxng` adds web search.
- `--profile infoserver` adds a self-hosted model registry (the dashboard otherwise uses the public one at `https://sysinfo.xinity.ai`).
- `--profile monitoring` adds Prometheus + Grafana.

Daemons (the GPU inference workers) are not in this stack. Install them per inference node with the Xinity CLI: see [deployment/cli/README.md](../cli/README.md).

## Prerequisites

- Docker Engine 24.0+
- Docker Compose v2
- The `xinity` CLI on a host that can reach the Compose Postgres on `127.0.0.1:5432`. Required to run migrations and to manage the running instance.
- For the `caddy` profile: a domain pointing at this host plus ports 80/443 free.

## Quick Start

### 1. Configure environment

```bash
cp example.env .env
./setup.sh    # generates secrets, prompts for admin emails and optional Caddy settings
```

What you must set in `.env` (the setup script handles most of these):

- `POSTGRES_PASSWORD`, `REDIS_PASSWORD`: `openssl rand -hex 32`
- `INSTANCE_ADMIN_EMAILS`: at least one email. Required for a usable instance in the default single-tenant mode.
- For HTTPS: `DOMAIN`, `ACME_EMAIL`, `ORIGIN`, `HTTP_OVERRIDE_ORIGIN`, `GATEWAY_URL`.
- For SearXNG: `SEARXNG_SECRET` (`openssl rand -hex 32`).

`BETTER_AUTH_SECRET` and `METRICS_AUTH` are not `.env` variables — `setup.sh` generates them directly into `secrets/` as Docker secrets. See `example.env` for everything else: multi-tenancy toggle, mail, S3 object storage, gateway tuning.

### 2. Run database migrations

The gateway and dashboard expect the schema to exist before they start. Bring Postgres up alone, then migrate with the CLI:

```bash
docker compose up -d postgres
xinity up db
```

`xinity up db` is interactive:

- Answer **yes** to "Do you have a connection URL for an existing database?", then enter `postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@127.0.0.1:5432/<POSTGRES_DB>` using values from your `.env`. Do **not** pick "No, help me set one up". That path installs a native PostgreSQL on the host.
- After applying migrations, the command moves on to a Redis discovery step. Press **Esc** to dismiss it; Redis has no schema and the Compose stack already configures its own Redis from `.env`.

Migrations are tracked, so re-running `xinity up db` after a release upgrade is safe.

### 3. Start the stack

```bash
# Localhost evaluation (default)
docker compose up -d

# HTTPS production
docker compose --profile caddy up -d

# Add optional services
docker compose --profile caddy --profile searxng --profile infoserver up -d
```

### 4. Access the dashboard

- Localhost: `http://localhost:5121`
- HTTPS:    `https://dashboard.<DOMAIN>`

Caddy obtains certificates on first start; allow a minute or two.

### 5. Connect the CLI to this instance

The CLI is how you manage daemons, run migrations on upgrade, smoke-check the stack, and script against the API. The fastest path is one command that creates the first user, the first organization, mints a dashboard API key, and writes both the key and the dashboard URL into the CLI's config:

```bash
xinity configure dashboardUrl https://dashboard.<DOMAIN>   # or http://localhost:5121
xinity act onboarding.cli
```

It prompts for name, email (must be in `INSTANCE_ADMIN_EMAILS` assuming `MULTI_TENANT_MODE=false`), password, and organization name. The resulting `apiKey` is persisted to `~/.config/xinity/config.json`, so subsequent CLI commands need no further setup. No browser required, safe for headless / SSH-only hosts.

Then smoke-check:

```bash
xinity doctor              # health report across the stack
xinity act --list-routes   # every dashboard API route the CLI can call
```

**Alternative (browser flow):** if you'd rather click through the dashboard for the first user and key, sign in at the dashboard URL with an address from `INSTANCE_ADMIN_EMAILS`, mint a key under **Settings -> API Keys** (shown only once, so copy it before closing the dialog), and wire the CLI:

```bash
xinity configure dashboardUrl https://dashboard.<DOMAIN>
xinity configure apiKey <paste-key-here>
```

`XINITY_DASHBOARD_URL` and `XINITY_API_KEY` env vars also work for one-off invocations without persisting.

## Configuration

### Secrets

For single-server deployments, plain `.env` (mode 600) is fine. Container env shows up in `docker inspect`, which is acceptable when the operator owns the host.

`setup.sh` already generates `secrets/db_connection_url`, `secrets/better_auth_secret`, `secrets/metrics_auth`, and `secrets/tether_secret`, and `docker-compose.yml` wires them into the relevant services as `*_FILE` environment variables (e.g. `DB_CONNECTION_URL_FILE`, `TETHER_SECRET_FILE`).

For any other *Xinity* service env var `VAR`, set `VAR_FILE` to a file path and the service reads the file at startup (direct env vars take precedence over the `_FILE` variant); wire it in via a `docker-compose.override.yml` using Compose's `secrets:` block.

This convention does not apply to `POSTGRES_PASSWORD`/`REDIS_PASSWORD` — Postgres and Redis are vanilla upstream images that this stack passes plain env vars to, not `_FILE` paths. Keep those in `.env` (mode 600), or add your own Compose override that maps them to Postgres/Redis's own secret-file support if you need them off-disk-in-env.

### Volumes

- `postgres-data`: Postgres data
- `redis-data`: Redis persistence
- `caddy-data`, `caddy-config`: Caddy's ACME account, issued certs, runtime config
- `./models.yaml`: mounted read-only into the infoserver container when the profile is active

### Custom subdomains

Override in `.env`:

```env
DASHBOARD_SUBDOMAIN=admin
GATEWAY_SUBDOMAIN=gateway
INFOSERVER_SUBDOMAIN=models
```

### Self-hosted model registry

The dashboard reads model info from `INFOSERVER_URL` (default: public `https://sysinfo.xinity.ai`). To run your own:

1. `cp models.yaml.example models.yaml` and edit.
2. Set `INFOSERVER_URL=http://infoserver:8090` in `.env`.
3. Start with the profile: `docker compose --profile infoserver up -d`.

Your `models.yaml` can extend the public registry. An included source has to use the same model
format as the file including it:

```yaml
includes:
  - https://sysinfo.xinity.ai/models/v2.json
models:
  my-custom-model-vllm:
    # ...
```

Upgrading an existing install whose `models.yaml` predates the current format? Leave it in place,
mount it somewhere separate, and point `MODEL_LEGACY_DIR` at that directory instead. It keeps
being served on the v1 endpoints until they are removed before 1.0.0. Mixing the two formats in one directory fails
startup on purpose.

## Maintenance

### Logs and restart

```bash
docker compose logs -f                 # all
docker compose logs -f dashboard       # one service
docker compose restart gateway         # rolling
```

### Upgrade

```bash
# Bump VERSION in .env to the new tag, then:
docker compose pull
xinity up db          # apply any new migrations
docker compose up -d  # picks up the new images
```

### Backup Postgres

```bash
docker compose exec postgres pg_dump -U xinity xinity > backup.sql
docker compose exec -T postgres psql -U xinity xinity < backup.sql
```

### Reset application data

Wipes Postgres and Redis. Migrations must be re-run afterward.

```bash
docker compose down
docker volume rm $(basename "$PWD")_postgres-data $(basename "$PWD")_redis-data
docker compose up -d postgres
xinity up db
docker compose up -d
```

Do **not** use `docker compose down -v`. That also wipes `caddy-data`, which holds the Let's Encrypt account; re-issuing certs can hit rate limits and lock you out for hours.

## Troubleshooting

### Auth routes 404 (sign-in, sign-up)

`@eslym/sveltekit-adapter-bun` does not use SvelteKit's `ORIGIN` for request URL rewriting. It uses `HTTP_OVERRIDE_ORIGIN`. Without it, Better Auth sees the Bun server's internal origin (e.g. `http://0.0.0.0:5121`) which doesn't match `ORIGIN`, and `/api/auth/*` falls through to a 404.

Fix: set both to the same public URL.

```env
ORIGIN=https://dashboard.example.com
HTTP_OVERRIDE_ORIGIN=https://dashboard.example.com
```

### SSL certificate issues (caddy profile)

1. Verify domain DNS points at this host.
2. Ports 80 and 443 must be publicly reachable.
3. `docker compose logs caddy`.
4. Let's Encrypt has rate limits; restarting Caddy in a loop will get you blocked for hours.

## Security checklist

- Strong `.env` (the setup script handles secret generation).
- `chmod 600 .env`.
- Consider `_FILE` secrets for production (see above).
- Firewall: allow only 80 / 443 publicly (everything else should be internal).
- `docker compose pull` on a schedule and re-`up -d` to pick up image updates.
- Regular Postgres backups.

## Support

- GitHub: https://github.com/xinity-ai/xinity-ai/issues
- Docs: https://docs.xinity.ai
