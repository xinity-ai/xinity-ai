# Xinity AI Docker Compose Deployment

This directory contains Docker Compose configuration for deploying the full Xinity AI stack.

## Architecture

The deployment includes:

- **PostgreSQL 17** - Primary database
- **Redis** - Caching and job queue
- **Gateway** - API gateway for model requests
- **Dashboard** - Web UI for administration
- **Infoserver** - Model information service (optional, defaults to public registry)
- **SearXNG** - Web search engine (optional)
- **Caddy** - Reverse proxy with automatic HTTPS

All services communicate via Docker bridge networking and are exposed through Caddy with automatic SSL certificates.

**Note:** By default, the dashboard uses the public Xinity model registry at `https://sysinfo.xinity.ai`. You only need to run a local infoserver if you want to host a custom model registry.

> **Daemon not included:** The daemon runs on inference hardware (GPU machines) and is not part of this stack. Install it separately on each inference node using the Xinity CLI. See [deployment/cli/README.md](../cli/README.md).

## Prerequisites

- Docker Engine 24.0+
- Docker Compose 2.20+
- A domain name pointing to your server (for automatic HTTPS)
- Ports 80 and 443 available

## Quick Start

### 1. Copy and configure environment file

```bash
cp .env.example .env
```

Edit `.env` and set:

**Required:**
- `DOMAIN` - Your domain (e.g., `example.com`)
- `ACME_EMAIL` - Email for Let's Encrypt certificates
- `POSTGRES_PASSWORD` - Secure password for PostgreSQL
- `REDIS_PASSWORD` - Secure password for Redis
- `BETTER_AUTH_SECRET` - Generate with `openssl rand -base64 32`

**Optional:**
- Adjust ports if needed (defaults are usually fine)
- Enable/disable SearXNG
- Customize subdomains

### 2. Start services

**Note:** The dashboard uses the public Xinity model registry at `https://sysinfo.xinity.ai` by default. You don't need to create `models.yaml` unless you want to host a custom model registry (see Advanced Configuration below).

```bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f

# Check status
docker compose ps
```

### 3. Access services

Once running, access via:

- Dashboard: `https://dashboard.yourdomain.com`
- API Gateway: `https://api.yourdomain.com`
- Model Registry: `https://sysinfo.xinity.ai` (public registry)

The first startup will:
1. Initialize the database
2. Run migrations
3. Obtain SSL certificates (may take 1-2 minutes)

Model information is fetched from the public registry at `https://sysinfo.xinity.ai` by default.

## Configuration

### Database

PostgreSQL data is persisted in the `postgres-data` volume. Automatic backups are not included - configure separately if needed.

### Secrets Management

**CRITICAL:** Never commit `.env` to version control.

#### Option A: `.env` file (simplest)

Store all secrets in `.env` alongside the compose file:

```bash
chmod 600 .env
```

This is fine for single-server deployments. Secrets end up as container environment variables, which are visible via `docker inspect`.

#### Option B: Docker secrets with `_FILE` (recommended for production)

Every Xinity service supports a `_FILE` convention: for any environment variable `VAR`, you can set `VAR_FILE` to a file path instead. The service reads the file at startup and uses its trimmed contents as the value. Direct environment variables take precedence over `_FILE` variants.

1. Create secret files:

```bash
mkdir -p secrets
openssl rand -base64 32 > secrets/postgres_password
openssl rand -base64 32 > secrets/redis_password
openssl rand -base64 32 > secrets/better_auth_secret
chmod 600 secrets/*
```

2. Reference them in your compose override or environment:

```yaml
# docker-compose.override.yml
services:
  gateway:
    environment:
      DB_CONNECTION_URL_FILE: /run/secrets/db_connection_url
    secrets:
      - db_connection_url
      - redis_url

  dashboard:
    environment:
      DB_CONNECTION_URL_FILE: /run/secrets/db_connection_url
      BETTER_AUTH_SECRET_FILE: /run/secrets/better_auth_secret
    secrets:
      - db_connection_url
      - better_auth_secret

secrets:
  db_connection_url:
    file: ./secrets/db_connection_url
  redis_url:
    file: ./secrets/redis_url
  better_auth_secret:
    file: ./secrets/better_auth_secret
```

With this approach, secrets are mounted as in-memory files at `/run/secrets/` inside each container and are never exposed as environment variables.

#### Rotating secrets

1. Update the secret file(s) in `secrets/`
2. Restart affected services: `docker compose restart gateway dashboard`

### Network Mode

By default, services use Docker bridge networking. This provides:
- Service isolation
- Automatic DNS resolution between containers
- Port mapping control

If you need host networking (advanced), edit `docker-compose.yml` and add `network_mode: host` to relevant services.

### Volumes

Persistent data locations:
- `postgres-data` - PostgreSQL database
- `redis-data` - Redis persistence (optional)
- `./models.yaml` - Model definitions (mounted read-only)
- `./logs/` - Application logs (optional)

## Maintenance

### View logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f dashboard
```

### Restart services

```bash
# Restart all
docker compose restart

# Restart specific service
docker compose restart gateway
```

### Update to new version

```bash
# Pull latest images
docker compose pull

# Restart with new images
docker compose up -d

# Remove old images
docker image prune
```

### Database migrations

Migrations run automatically on startup. To run manually:

```bash
docker compose run --rm gateway bun run migrate
```

### Backup database

```bash
# Create backup
docker compose exec postgres pg_dump -U xinity xinity > backup.sql

# Restore backup
docker compose exec -T postgres psql -U xinity xinity < backup.sql
```

## Troubleshooting

### Services won't start

1. Check logs: `docker compose logs`
2. Verify `.env` file exists and has all required variables
3. Ensure ports 80 and 443 are not in use
4. Check DNS: domain must resolve to server IP

### SSL certificate issues

Caddy obtains certificates automatically. If failing:

1. Verify domain DNS is correct
2. Ensure ports 80/443 are publicly accessible
3. Check Caddy logs: `docker compose logs caddy`
4. Let's Encrypt rate limits: wait if you've restarted too many times

### Database connection errors

1. Wait for PostgreSQL to fully start (check logs)
2. Verify `DB_CONNECTION_URL` in `.env` is correct
3. Check PostgreSQL logs: `docker compose logs postgres`

### Permission errors

If containers can't write logs:

```bash
mkdir -p logs
chmod 777 logs
```

### Auth routes return 404 (sign-in, sign-up, etc.)

The `@eslym/sveltekit-adapter-bun` adapter does **not** use SvelteKit's `ORIGIN` env var to rewrite request URLs. It uses its own `HTTP_OVERRIDE_ORIGIN` env var instead. Without it, Better Auth sees the Bun server's internal origin (e.g., `http://0.0.0.0:5121`) which doesn't match the configured `ORIGIN`, so all `/api/auth/*` requests fall through unhandled and return 404.

**Fix:** Set `HTTP_OVERRIDE_ORIGIN` to the same value as `ORIGIN`:

```env
ORIGIN=https://dashboard.example.com
HTTP_OVERRIDE_ORIGIN=https://dashboard.example.com
```

This only affects production builds. In development, Vite serves on the same address as `ORIGIN` so they naturally match.

### Reset everything

**WARNING:** This deletes all data!

```bash
docker compose down -v
docker compose up -d
```

## Security Considerations

- Change all default passwords in `.env`
- Use strong secrets (minimum 32 characters)
- Keep `.env` file permissions restricted: `chmod 600 .env`
- Use Docker secrets with the `_FILE` pattern for production (see Secrets Management above)
- Regularly update images: `docker compose pull`
- Monitor logs for suspicious activity
- Enable firewall rules (allow only 80/443)
- Regular database backups

## Local Evaluation (No Domain Required)

To try Xinity locally without a domain or HTTPS, override the Caddy service and access services directly:

```bash
cp .env.example .env
# Fill in passwords and BETTER_AUTH_SECRET, set DOMAIN to anything (unused)
```

Then start without Caddy and expose ports directly:

```bash
docker compose up -d postgres redis db-migrate gateway dashboard
```

Access the dashboard at `http://localhost:5121` and the gateway at `http://localhost:4121`. You will need to set the auth-related environment variables to match:

```env
BETTER_AUTH_URL=http://localhost:5121
ORIGIN=http://localhost:5121
HTTP_OVERRIDE_ORIGIN=http://localhost:5121
PUBLIC_LLM_API_URL=http://localhost:4121/v1
```

And uncomment the `ports:` sections for gateway and dashboard in `docker-compose.yml`.

## Advanced Configuration

### Disable SearXNG

Set in `.env`:
```
SEARXNG_ENABLED=false
```

### Use custom infoserver

By default, the dashboard uses the public model registry at `https://sysinfo.xinity.ai`. To host your own:

1. Create `models.yaml` from the example:
   ```bash
   cp models.yaml.example models.yaml
   # Edit models.yaml with your custom models
   ```

2. Enable the infoserver profile in `.env`:
   ```
   INFOSERVER_PROFILE=infoserver
   INFOSERVER_URL=http://infoserver:8090
   ```

3. Start with the infoserver profile:
   ```bash
   docker compose --profile infoserver up -d
   ```

Your custom models can include the public registry:
```yaml
includes:
  - https://sysinfo.xinity.ai/models.yaml

models:
  my-custom-model:
    # ... your model configuration
```

### Custom subdomains

Edit `.env`:
```
DASHBOARD_SUBDOMAIN=admin
GATEWAY_SUBDOMAIN=gateway
INFOSERVER_SUBDOMAIN=models
```

### External database

To use an external PostgreSQL instance:

1. Remove `postgres` service from `docker-compose.yml`
2. Update `DB_CONNECTION_URL` in `.env`
3. Run migrations manually

### Development mode

For development without HTTPS:

1. Comment out Caddy service
2. Access services directly via ports (see `docker-compose.yml`)
3. Update `BETTER_AUTH_URL` and `ORIGIN` to use `http://localhost`

## Support

For issues and questions:
- GitHub Issues: https://github.com/xinity-ai/xinity-ai/issues
- Documentation: https://docs.xinity.ai
