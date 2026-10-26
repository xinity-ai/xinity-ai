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

env_value() {
    grep -E "^$1=" .env | head -n1 | cut -d= -f2-
}

set_env() {
    if grep -qE "^(# )?$1=" .env; then
        sed_inplace "s|^\(# \)\{0,1\}$1=.*|$1=$2|" .env
    else
        printf '%s=%s\n' "$1" "$2" >> .env
    fi
}

prompt_required() {
    local answer
    while true; do
        if [ -n "$2" ]; then
            echo -n "$1 [$2]: " >&2
        else
            echo -n "$1: " >&2
        fi
        read -r answer
        answer=${answer:-$2}
        if [ -n "$answer" ]; then
            printf '%s' "$answer"
            return
        fi
        echo "  A value is required." >&2
    done
}

if [ -f .env ]; then
    echo -n ".env already exists. Overwrite? (y/N): "
    read -r REPLY
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm .env
    else
        echo "Keeping existing .env and filling in only what it lacks."
    fi
fi

if [ ! -f .env ]; then
    cp example.env .env
fi

for key in POSTGRES_PASSWORD SEARXNG_SECRET; do
    if [ -z "$(env_value "$key")" ]; then
        set_env "$key" "$(gen_url_safe)"
        echo "Generated $key."
    fi
done

echo
echo "Instance admin email(s), comma-separated."
set_env INSTANCE_ADMIN_EMAILS "$(prompt_required "Admin email(s)" "$(env_value INSTANCE_ADMIN_EMAILS)")"

echo -n "Open the instance to self-service signup for any user? (y/N): "
read -r REPLY
if [[ $REPLY =~ ^[Yy]$ ]]; then
    set_env MULTI_TENANT_MODE true
fi

echo
echo "Caddy / HTTPS deployment is optional (activated with --profile caddy)."
echo -n "Configure it now? (y/N): "
read -r REPLY
if [[ $REPLY =~ ^[Yy]$ ]]; then
    DOMAIN=$(prompt_required "  Domain (e.g. example.com)" "$(env_value DOMAIN)")
    echo -n "  Let's Encrypt email (optional, for expiry notices): "
    read -r ACME_EMAIL
    set_env DOMAIN "$DOMAIN"
    set_env ORIGIN "https://dashboard.${DOMAIN}"
    set_env HTTP_OVERRIDE_ORIGIN "https://dashboard.${DOMAIN}"
    set_env GATEWAY_URL "https://api.${DOMAIN}"
    if [ -n "$ACME_EMAIL" ]; then
        set_env ACME_EMAIL "$ACME_EMAIL"
    fi
fi

# App secrets reach the containers as Docker secrets (the *_FILE convention), so
# they live only here, never in .env. Generated once, reused on re-runs.
mkdir -p secrets && chmod 700 secrets
[ -f secrets/better_auth_secret ] || printf '%s' "$(gen_base64)" > secrets/better_auth_secret
[ -f secrets/metrics_password ] || printf '%s' "$(gen_url_safe)" > secrets/metrics_password
[ -f secrets/tether_secret ] || printf '%s' "$(gen_url_safe)" > secrets/tether_secret
[ -f secrets/redis_password ] || printf '%s' "$(gen_url_safe)" > secrets/redis_password
# Never regenerated: it decrypts what the dashboard already sealed, so a new one orphans those values.
[ -f secrets/xinity_secret_key ] || printf '%s' "$(gen_base64)" > secrets/xinity_secret_key
printf 'metrics:%s' "$(cat secrets/metrics_password)" > secrets/metrics_auth
chmod 600 secrets/better_auth_secret secrets/metrics_password secrets/metrics_auth secrets/tether_secret secrets/redis_password secrets/xinity_secret_key

# Connection URLs carry credentials, so the apps receive them as secrets too.
# Derived from .env and secrets/, rewritten each run to stay in sync.
pg_user=$(grep -E '^POSTGRES_USER=' .env | head -n1 | cut -d= -f2-)
pg_db=$(grep -E '^POSTGRES_DB=' .env | head -n1 | cut -d= -f2-)
pg_pw=$(grep -E '^POSTGRES_PASSWORD=' .env | head -n1 | cut -d= -f2-)
printf 'postgresql://%s:%s@postgres:5432/%s' "${pg_user:-xinity}" "$pg_pw" "${pg_db:-xinity}" > secrets/db_connection_url
printf 'redis://:%s@redis:6379' "$(cat secrets/redis_password)" > secrets/redis_url
chmod 600 secrets/db_connection_url secrets/redis_url

chmod 600 .env

cat <<'EOF'

Setup complete. Next:
  1. Run migrations against the Compose Postgres:
       docker compose up -d postgres
       xinity up db
  2. Bring up the rest of the stack:
       docker compose up -d                          # localhost (default)
       docker compose --profile caddy up -d          # HTTPS via Caddy
       docker compose --profile searxng up -d        # add SearXNG web search
       docker compose --profile infoserver up -d     # self-hosted model registry
  3. Connect the CLI to the instance: see README.md.

Keep .env out of version control.
EOF
