# xinity-ai-dashboard

SvelteKit admin dashboard for Xinity AI. Built with Vite + Bun, Tailwind CSS, and a small set of UI and server utilities.

## Requirements

- Bun >= 1.3
- Local dependencies running via `docker compose up -d` at repo root
- `.env` configured in this directory (see `example.env`)

## Stack overview

- SvelteKit app with Bun adapter (`packages/xinity-ai-dashboard/svelte.config.js`)
- Vite dev/build pipeline (`packages/xinity-ai-dashboard/vite.config.ts`)
- Tailwind CSS via the Vite plugin and `src/app.css`
- shadcn-svelte component registry configuration (`packages/xinity-ai-dashboard/components.json`)
- ORPC client/server utilities (`src/lib/orpc`)
- Auth helpers built on better-auth (`src/lib/auth.ts`, `src/lib/server/auth-server.ts`)
- Email support via nodemailer + MJML (`src/lib/server/email.ts`)
- Metrics via `common-env` metric primitives (`src/lib/server/metrics.ts`)

## Development

```bash
bun run dev
```

## Build and preview

```bash
bun run build
bun run preview
```

## shadcn-svelte components

This repo uses shadcn-svelte for UI components. To add new components:

```bash
bun x shadcn-svelte@latest add button dropdown-menu
```

Docs and component list: https://shadcn-svelte.com/

## Project structure

- `src/routes`: SvelteKit routes, layouts, and endpoints
- `src/lib/components`: UI components (including shadcn-svelte generated ones)
- `src/lib/server`: server-only modules (auth, email, metrics, logging)
- `src/lib/orpc`: ORPC client/server configuration
- `src/lib/state`: shared stores and state helpers
- `src/lib/assets`: local assets imported by the app
- `src/params`: custom route param matchers
- `static`: static assets served as-is

## MCP Server

The dashboard exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/mcp`, enabling AI assistants to manage resources through natural language. It is enabled by default and can be disabled with `MCP_ENABLED=false`.

Configure your MCP client to connect:

```json
{
  "mcpServers": {
    "xinity-ai": {
      "url": "https://your-dashboard/mcp",
      "headers": { "Authorization": "Bearer sk_..." }
    }
  }
}
```

See the in-app documentation at `/docs/access-methods` for detailed setup instructions per client (Claude Desktop, Cursor, Windsurf, Claude Code CLI). For implementation details, see the [MCP developer guide](docs/mcp.md).

## Configuration

<!-- [sync:config] - generated from the config declaration, do not edit -->

### HTTP server

Where it listens.

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address (use 0.0.0.0 to listen on all interfaces). |
| `HTTP_PORT` | `5173` | TCP port the server listens on. |
| `IDLE_TIMEOUT` | `30` | Seconds a connection may go without traffic before it is closed (Bun allows at most 255). |
| `UNIX_SOCKET` | (unset) | Unix socket path (overrides HOST and HTTP_PORT when set). |

### Database

| Variable | Default | Description |
|---|---|---|
| `DB_CONNECTION_URL` | (required) | PostgreSQL connection string (e.g. postgresql://user:pass@host:5432/dbname). Secret. |
| `DB_MAX_CONNECTIONS` | `10` | Maximum PostgreSQL connection pool size. |

### Authentication

Who can sign in, and who is allowed to create an organization.

| Variable | Default | Description |
|---|---|---|
| `BETTER_AUTH_SECRET` | (required) | Better Auth secret key, generate with: openssl rand -base64 32. Secret. |
| `SIGNUP_ENABLED` | `true` | Enable user signup. |
| `MULTI_TENANT_MODE` | `false` | Allow any authenticated user to create organizations. |
| `INSTANCE_ADMIN_EMAILS` | (empty) | Emails of users who get instance-wide admin privileges (can manage all orgs). |

### Outbound mail

Used for invitations, password resets and notifications. Disabled when unset.

Off unless all of `MAIL_URL` are set.

| Variable | Default | Description |
|---|---|---|
| `MAIL_URL` | (required) | SMTP mail server URL (e.g. smtp://user:pass@mail.example.com:587). Secret. |
| `MAIL_FROM` | (required) | Email sender address (e.g. noreply@mydomain.com). |

### Model catalog

| Variable | Default | Description |
|---|---|---|
| `INFOSERVER_URL` | `https://sysinfo.xinity.ai` | Infoserver URL (default hosted: https://sysinfo.xinity.ai, or your self-hosted instance). |
| `INFOSERVER_CACHE_TTL_MS` | `600000` | How long the local catalog snapshot is trusted before a conditional re-fetch (ms). A refresh costs one 304 when nothing changed, so the ceiling on how stale a new entry can be is what this trades against. |

### Compute

Model deployment across inference nodes, and what the Compute page shows.

| Variable | Default | Description |
|---|---|---|
| `COMPUTE_MANAGEMENT_ENABLED` | `true` | Enable compute management. |
| `DEPLOYMENT_STRATEGY` | `balanced` | Node selection strategy for new model installations. 'first-fit' picks the first node that fits (deterministic). 'balanced' picks the node with the most absolute free VRAM (spread for HA). 'bin-pack' picks the tightest fit (consolidate so idle nodes stay drainable). 'proportional' picks the node with the lowest percent utilization (fair spread across heterogeneous nodes). One of `first-fit`, `balanced`, `bin-pack`, `proportional`. |
| `PROMETHEUS_URL` | (unset) | Prometheus server URL for live GPU metrics overlay on the Compute page (e.g. http://prometheus:9090). Enables utilization rings and energy readouts on compute nodes. |

### Audit event export

Mirrors audit events to Loki for SIEM ingestion. Requires a license with the audit-log feature.

Off unless all of `AUDIT_LOKI_URL` are set.

| Variable | Default | Description |
|---|---|---|
| `AUDIT_LOKI_URL` | (required) | Loki base URL to mirror audit events to (e.g. http://localhost:6122). |
| `AUDIT_LOKI_AUTH` | (unset) | Basic auth for AUDIT_LOKI_URL as user:pass. Only needed when the Loki endpoint is authenticated. Secret. |
| `AUDIT_LOKI_TENANT` | (unset) | Tenant id sent as X-Scope-OrgID. Only needed for multi-tenant Loki or Grafana Cloud. |

### Metrics endpoint

| Variable | Default | Description |
|---|---|---|
| `METRICS_AUTH` | (required) | Basic auth for the /metrics endpoint (format: user:pass, comma-separated for multiple). Secret. |

### Object storage

SeaweedFS or any S3-compatible endpoint for conversation media. Without it the database carries the bytes itself.

Off unless all of `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` are set.

| Variable | Default | Description |
|---|---|---|
| `S3_ENDPOINT` | (required) | SeaweedFS / S3-compatible endpoint URL. |
| `S3_ACCESS_KEY_ID` | (required) | S3 access key ID. Secret. |
| `S3_SECRET_ACCESS_KEY` | (required) | S3 secret access key. Secret. |
| `S3_BUCKET` | `xinity-media` | S3 bucket for media objects. |
| `S3_REGION` | `us-east-1` | S3 region (use 'us-east-1' for SeaweedFS). |

### TLS

Opt-in HTTPS. See https://github.com/xinity-ai/xinity-ai/blob/main/docs/security/tls.md

Off unless all of `XINITY_TLS_CERT`, `XINITY_TLS_KEY` are set.

| Variable | Default | Description |
|---|---|---|
| `XINITY_TLS_CERT` | (required) | PEM-encoded TLS certificate. Secret. |
| `XINITY_TLS_KEY` | (required) | PEM-encoded TLS private key. Secret. |

### Reverse proxy

Only needed when something sits in front of this service.

| Variable | Default | Description |
|---|---|---|
| `HTTP_IP_HEADER` | (unset) | Header the client IP is forwarded in (e.g. x-forwarded-for). Without it, requests all appear to come from the proxy. |
| `HTTP_XFF_DEPTH` | `1` | Number of proxies in front. Anything further left in the header is client-supplied and forgeable. |
| `HTTP_TRUSTED_PROXIES` | (empty) | Restricts the forwarding header to these addresses or CIDR ranges (e.g. 10.0.0.0/8). Empty accepts it from any source, which is what a proxy-only route needs. |

### Logging

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `debug` | Log level. One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |
| `LOG_DIR` | (unset) | Log file directory (enables file logging). |

### Other

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | (required) | Node environment. One of `production`, `development`, `test`. |
| `APP_NAME` | `Xinity Admin` | Application display name. |
| `ORIGIN` | `http://localhost:5173` | Public origin URL browsers reach this dashboard at, no trailing slash (e.g. https://xinity.mydomain.com). The default only suits local development. |
| `TRUSTED_ORIGINS` | (empty) | Additional trusted origins for CSRF validation behind reverse proxies. |
| `GATEWAY_URL` | `http://localhost:4010` | Gateway base URL shown to users in docs and code examples (e.g. https://api.example.com). Must NOT include the /v1 path segment - that is appended where needed. A trailing slash is stripped. |
| `LICENSE_KEY` | (unset) | License key for unlocking paid features (Ed25519-signed token). Secret. |
| `MCP_ENABLED` | `true` | Enable the /mcp Model Context Protocol endpoint. |
| `NOTIFICATIONS_ENABLED` | `true` | Enable the notification scheduler (deployment status, node health, capacity warnings, weekly reports). |

<!-- [/sync:config] -->

Every variable supports the `_FILE` suffix convention (e.g. `DB_CONNECTION_URL_FILE`) for reading the value from a file.

## Testing

```bash
bun run test            # all dashboard tests
bun run test:api        # API tests only
bun run test:headed     # browser tests with visible browser
bun run test:setup      # run test setup (user/org creation) standalone
```

The dashboard tests require a running application and its dependencies. Before running tests locally:

1. Start local dependencies from the repo root:
   ```bash
   docker compose up -d
   cd packages/common-db && bun run migrate
   ```

2. Start the infoserver:
   ```bash
   cd packages/xinity-infoserver && bun run dev
   ```

3. Build and run the dashboard:
   ```bash
   cd packages/xinity-ai-dashboard
   cp example.env .env    # if not already configured
   bun run build
   bun run preview
   ```

The tests expect the dashboard at `http://localhost:5173`. On first run, the test setup automatically creates test users and organizations via the API.

## License

This package is licensed under the **Elastic License 2.0 (ELv2)**, which differs from the Apache 2.0 license used by the rest of the monorepo. See the [LICENSE](./LICENSE) file in this directory for the full terms.

## Notes

- Mailhog UI runs at `http://localhost:8025` when the dev Docker stack is up.
- `INFOSERVER_URL` points at `http://localhost:8090` for a locally-run infoserver (default in `example.env`).
