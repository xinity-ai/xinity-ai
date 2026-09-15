# Xinity Tether

SSE bridge between the daemon fleet and the PostgreSQL database. Daemons open a persistent SSE connection to the tether instead of connecting to the database directly. The tether streams desired state (model installations) to each daemon, collects status reports, and tracks node liveness.

## Development

```bash
bun install
bun run dev
```

## How it works

1. A daemon connects to `GET /api/v1/stream` with a `Bearer` token (the shared `TETHER_SECRET`) and sends its hardware profile as the SSE request body. The tether upserts the node record in the database.
2. The tether subscribes to PostgreSQL `LISTEN/NOTIFY` for desired-state changes. When the dashboard updates a deployment, the tether pushes the new state to the affected daemon over its SSE connection.
3. Daemons report installation lifecycle state back via `POST /api/v1/status`. The tether batches these writes to the database.
4. A keepalive is sent every `KEEPALIVE_INTERVAL_MS`. If a connection goes silent for `LIVENESS_TIMEOUT_MS`, the tether marks the node as offline.

## Configuration

<!-- [sync:config] - generated from the config declaration, do not edit -->

### HTTP server

Where the tether listens, and how it keeps daemon connections alive.

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address (use 0.0.0.0 to listen on all interfaces). |
| `PORT` | `4020` | Listen port. |
| `IDLE_TIMEOUT` | `255` | Seconds a connection may go without traffic before it is closed (Bun allows at most 255). |
| `UNIX_SOCKET` | (unset) | Unix socket path (overrides HOST/PORT when set). |
| `KEEPALIVE_INTERVAL_MS` | `15000` | SSE keepalive interval in ms. Can be set to `@dynamic` to take its value from the dashboard. |
| `LIVENESS_TIMEOUT_MS` | `45000` | Time before a silent connection is considered dead. Can be set to `@dynamic` to take its value from the dashboard. |

### Database

| Variable | Default | Description |
|---|---|---|
| `DB_CONNECTION_URL` | (required) | PostgreSQL connection string (e.g. postgresql://user:pass@host:5432/dbname). Secret. |

### Metrics endpoint

| Variable | Default | Description |
|---|---|---|
| `METRICS_AUTH` | (unset) | Basic auth for the /metrics endpoint (format: user:pass, comma-separated for multiple). Secret. |

### Logging

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `debug` | Log level. One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |
| `LOG_DIR` | (unset) | Log file directory (enables file logging). |

### TLS

Opt-in HTTPS. See https://github.com/xinity-ai/xinity-ai/blob/main/docs/security/tls.md

Off unless all of `XINITY_TLS_CERT`, `XINITY_TLS_KEY` are set.

| Variable | Default | Description |
|---|---|---|
| `XINITY_TLS_CERT` | (required) | PEM-encoded TLS certificate. Secret. |
| `XINITY_TLS_KEY` | (required) | PEM-encoded TLS private key. Secret. |

### Other

| Variable | Default | Description |
|---|---|---|
| `TETHER_SECRET` | (required) | Shared secret authenticating daemons to the tether. Secret. |

<!-- [/sync:config] -->

Every variable supports the `_FILE` suffix convention (e.g. `TETHER_SECRET_FILE`) for reading the value from a file.

## Testing

```bash
bun test
```
