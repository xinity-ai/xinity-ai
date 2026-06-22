#!/bin/bash
set -e

# Portable on GNU and BSD/macOS sed.
sed_inplace() {
    sed -i.bak "$1" "$2" && rm -f "${2}.bak"
}

gen_url_safe() { openssl rand -hex 32; }
gen_base64() { openssl rand -base64 32; }

echo "Xinity AI Docker Compose Setup"
echo

for tool in docker openssl; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "$tool is required. Install it and re-run."
        exit 1
    fi
done
if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose v2 is required ('docker compose version' failed)."
    exit 1
fi

fresh_env=false
if [ -f .env ]; then
    echo -n ".env already exists. Overwrite? (y/N): "
    read -r REPLY
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm .env
        fresh_env=true
    else
        echo "Keeping existing .env. Secrets will NOT be regenerated."
    fi
else
    fresh_env=true
fi

if [ ! -f .env ]; then
    cp example.env .env
fi

if [ "$fresh_env" = true ]; then
    POSTGRES_PASSWORD=$(gen_url_safe)
    REDIS_PASSWORD=$(gen_url_safe)
    SEARXNG_SECRET=$(gen_url_safe)

    sed_inplace "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" .env
    sed_inplace "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${REDIS_PASSWORD}|" .env
    sed_inplace "s|^# SEARXNG_SECRET=.*|SEARXNG_SECRET=${SEARXNG_SECRET}|" .env
    echo "Generated POSTGRES_PASSWORD, REDIS_PASSWORD, SEARXNG_SECRET."
fi

echo
echo "Instance admin email(s) (comma-separated). Required for a usable instance"
echo "in the default single-tenant mode."
echo -n "Admin email(s): "
read -r INSTANCE_ADMIN_EMAILS
if [ -n "$INSTANCE_ADMIN_EMAILS" ]; then
    sed_inplace "s|^INSTANCE_ADMIN_EMAILS=.*|INSTANCE_ADMIN_EMAILS=${INSTANCE_ADMIN_EMAILS}|" .env
fi

echo -n "Open the instance to self-service signup for any user? (y/N): "
read -r REPLY
if [[ $REPLY =~ ^[Yy]$ ]]; then
    sed_inplace "s|^MULTI_TENANT_MODE=.*|MULTI_TENANT_MODE=true|" .env
fi

echo
echo "Caddy / HTTPS deployment is optional (activated with --profile caddy)."
echo -n "Configure it now? (y/N): "
read -r REPLY
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -n "  Domain (e.g. example.com): "
    read -r DOMAIN
    echo -n "  Let's Encrypt email: "
    read -r ACME_EMAIL
    if [ -n "$DOMAIN" ]; then
        sed_inplace "s|^# DOMAIN=.*|DOMAIN=${DOMAIN}|" .env
        sed_inplace "s|^# ORIGIN=.*|ORIGIN=https://dashboard.${DOMAIN}|" .env
        sed_inplace "s|^# HTTP_OVERRIDE_ORIGIN=.*|HTTP_OVERRIDE_ORIGIN=https://dashboard.${DOMAIN}|" .env
        sed_inplace "s|^# GATEWAY_URL=.*|GATEWAY_URL=https://api.${DOMAIN}|" .env
    fi
    if [ -n "$ACME_EMAIL" ]; then
        sed_inplace "s|^# ACME_EMAIL=.*|ACME_EMAIL=${ACME_EMAIL}|" .env
    fi
fi

# App secrets reach the containers as Docker secrets (the *_FILE convention), so
# they live only here, never in .env. Generated once, reused on re-runs.
mkdir -p secrets && chmod 700 secrets
[ -f secrets/better_auth_secret ] || printf '%s' "$(gen_base64)" > secrets/better_auth_secret
[ -f secrets/metrics_password ] || printf '%s' "$(gen_url_safe)" > secrets/metrics_password
# Apps need the full user:pass; Prometheus's password_file needs the password only.
printf 'metrics:%s' "$(cat secrets/metrics_password)" > secrets/metrics_auth
chmod 600 secrets/better_auth_secret secrets/metrics_password secrets/metrics_auth

# The connection URL carries the DB credentials, so the apps receive it as a
# secret too. Derived from .env, rewritten each run to stay in sync.
pg_user=$(grep -E '^POSTGRES_USER=' .env | head -n1 | cut -d= -f2-)
pg_db=$(grep -E '^POSTGRES_DB=' .env | head -n1 | cut -d= -f2-)
pg_pw=$(grep -E '^POSTGRES_PASSWORD=' .env | head -n1 | cut -d= -f2-)
printf 'postgresql://%s:%s@postgres:5432/%s' "${pg_user:-xinity}" "$pg_pw" "${pg_db:-xinity}" > secrets/db_connection_url
chmod 600 secrets/db_connection_url

chmod 600 .env

cat <<'EOF'

Setup complete. Next:
  1. Run migrations against the Compose Postgres:
       docker compose up -d postgres
       xinity up db    # press Esc when prompted for Redis
  2. Bring up the rest of the stack:
       docker compose up -d                          # localhost (default)
       docker compose --profile caddy up -d          # HTTPS via Caddy
       docker compose --profile searxng up -d        # add SearXNG web search
       docker compose --profile infoserver up -d     # self-hosted model registry
  3. Connect the CLI to the instance: see README.md.

Keep .env out of version control.
EOF
