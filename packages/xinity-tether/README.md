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

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4020` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `UNIX_SOCKET` | (unset) | Unix socket path (overrides HOST/PORT) |
| `DB_CONNECTION_URL` | (required) | PostgreSQL connection string |
| `TETHER_SECRET` | (required) | Shared secret for daemon authentication |
| `METRICS_AUTH` | (unset) | Basic auth for `/metrics` (`user:pass`) |
| `IDLE_TIMEOUT` | `255` | Idle connection timeout in seconds (max 255) |
| `KEEPALIVE_INTERVAL_MS` | `15000` | SSE keepalive interval in ms (must be at most a third of IDLE_TIMEOUT) |
| `LIVENESS_TIMEOUT_MS` | `45000` | Time before a silent connection is considered dead |
| `LOG_LEVEL` | `debug` | Log level |
| `LOG_DIR` | (unset) | Log file directory (enables file logging) |

Every variable supports the `_FILE` suffix convention for reading values from files.

## Testing

```bash
bun test
```
