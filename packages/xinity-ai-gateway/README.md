# xinity-ai-gateway

API gateway service for Xinity AI. Provides an OpenAI-compatible API, routes traffic across inference nodes, records usage, and exposes Prometheus metrics. Depends on PostgreSQL, Redis, and the infoserver.

## Requirements

- Bun >= 1.3
- Local dependencies running via `docker compose up -d` at repo root
- Root `.env` configured (see `example.env`)

## Development

```bash
bun run dev
```

## Architecture

- `src/gatewayServer.ts` starts the HTTP server and exposes `/v1/*` OpenAI-style endpoints.
- `src/llm-forward/*` handles request validation, model resolution, load balancing, and forwarding to inference nodes.
- `src/callLogger.ts` writes call body (input/output messages) to the database.
- `src/usageRecorder.ts` writes per-request usage events (tokens, duration, success).
- `src/metrics.ts` exposes Prometheus metrics at `/metrics`.
- `src/image-store.ts` handles multimodal image upload to S3 and deduplication.
- `src/llm-forward/load-balancer.ts` implements three strategies: `random`, `round-robin`, and `least-connections` (default), with prefix-cache affinity for KV cache hit optimization.
- `src/llm-forward/model-data.ts` handles canary deployment traffic splitting.
- `src/llm-forward/endpoints/handle-responses.ts` implements the OpenAI Responses API with built-in web search and web fetch tools.

`callLogger` and `usageRecorder` both buffer in memory, flushing at 50 rows or after 200ms. A hard
crash drops whatever is still queued, so neither table is an audit record.

## Live API documentation

The gateway serves its own OpenAPI documentation:

- `GET /openapi.json` — the OpenAPI 3.1 spec, generated from the oRPC router plus hand-authored fragments for the `/v1/*` OpenAI-compatible routes (`src/openai-compat-openapi.ts`).
- `GET /docs` — Scalar UI rendering of the same spec.

When extending or modifying the OpenAI-compatible routes, update the hand-authored fragments in `src/openai-compat-openapi.ts` so the documentation stays in sync.

## Configuration

<!-- [sync:config] - generated from the config declaration, do not edit -->

### HTTP server

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address (use 0.0.0.0 to listen on all interfaces). |
| `PORT` | `4010` | Listen port. |
| `IDLE_TIMEOUT` | `255` | Seconds a connection may go without traffic before it is closed (Bun allows at most 255). |
| `UNIX_SOCKET` | (unset) | Unix socket path (overrides HOST/PORT when set). |

### Database

| Variable | Default | Description |
|---|---|---|
| `DB_CONNECTION_URL` | (required) | PostgreSQL connection string (e.g. postgresql://user:pass@host:5432/dbname). Secret. |
| `DB_MAX_CONNECTIONS` | `20` | Maximum PostgreSQL connection pool size. |

### Cache

Redis, and the lifetimes of what the gateway keeps in it.

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | (required) | Redis or Valkey connection URL (e.g. redis://:PASSWORD@localhost:6379). Percent-encode the password. Secret. |
| `RESPONSE_CACHE_TTL_SECONDS` | `3600` | How long an identical completion is served from cache instead of the backend. Can be set to `@dynamic` to take its value from the dashboard. |
| `CACHE_APPLICATION_TTL_SECONDS` | `300` | How long an application name to id lookup is cached. Can be set to `@dynamic` to take its value from the dashboard. |
| `CACHE_API_KEY_TTL_SECONDS` | `120` | How long a validated API key is cached, so every request does not hit the database. Can be set to `@dynamic` to take its value from the dashboard. |
| `CACHE_AUTH_FAILURE_TTL_SECONDS` | `10` | How long a rejected API key is remembered. Short, so re-enabling a key takes effect promptly. Can be set to `@dynamic` to take its value from the dashboard. |
| `CACHE_MODEL_TTL_SECONDS` | `60` | How long a model deployment lookup is cached. Can be set to `@dynamic` to take its value from the dashboard. |
| `CACHE_DIGEST_MAX_ENTRIES` | `5000` | Entries held in the in-process chat message digest cache, which avoids re-hashing repeated history. Can be set to `@dynamic` to take its value from the dashboard. |

### Model catalog

| Variable | Default | Description |
|---|---|---|
| `INFOSERVER_URL` | `https://sysinfo.xinity.ai` | Infoserver URL (default hosted: https://sysinfo.xinity.ai, or your self-hosted instance). |
| `INFOSERVER_CACHE_TTL_MS` | `600000` | How long the local catalog snapshot is trusted before a conditional re-fetch (ms). A refresh costs one 304 when nothing changed, so the ceiling on how stale a new entry can be is what this trades against. |

### Metrics endpoint

| Variable | Default | Description |
|---|---|---|
| `METRICS_AUTH` | (unset) | Basic auth for the /metrics endpoint (format: user:pass, comma-separated for multiple). Secret. |

### Logging

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `debug` | Log level. One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |
| `LOG_DIR` | (unset) | Log file directory (enables file logging). |

### Object storage

Any S3-compatible endpoint for conversation media. Without it the database carries the bytes itself.

Off unless all of `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` are set.

| Variable | Default | Description |
|---|---|---|
| `S3_ENDPOINT` | (required) | S3-compatible endpoint URL. |
| `S3_ACCESS_KEY_ID` | (required) | S3 access key ID. Secret. |
| `S3_SECRET_ACCESS_KEY` | (required) | S3 secret access key. Secret. |
| `S3_BUCKET` | `xinity-media` | S3 bucket for media objects. |
| `S3_REGION` | `us-east-1` | S3 region. Endpoints that are not AWS usually ignore it, and 'us-east-1' is the conventional value. |

### TLS

Opt-in HTTPS. See https://github.com/xinity-ai/xinity-ai/blob/main/docs/security/tls.md

Off unless all of `XINITY_TLS_CERT`, `XINITY_TLS_KEY` are set.

| Variable | Default | Description |
|---|---|---|
| `XINITY_TLS_CERT` | (required) | PEM-encoded TLS certificate. Secret. |
| `XINITY_TLS_KEY` | (required) | PEM-encoded TLS private key. Secret. |

### Web search

Backend for web-search-augmented generation. Disabled when unset.

| Variable | Default | Description |
|---|---|---|
| `WEB_SEARCH_PROVIDER` | (unset) | Web search backend. When unset, web search is disabled. One of `searxng`, `google`, `bing`, `brave`, `serper`, `tavily`. |
| `WEB_SEARCH_CREDENTIAL` | (unset) | Provider credential: searxng=instance URL, google=apikey:cx, bing/brave/serper/tavily=API key. Secret. |
| `WEB_SEARCH_ENGINE_URL` | (unset) | @deprecated Use WEB_SEARCH_PROVIDER + WEB_SEARCH_CREDENTIAL instead. SearXNG search engine URL. |

### Inference backends

How the gateway picks a node, how long it waits, and how it trusts one.

| Variable | Default | Description |
|---|---|---|
| `LOAD_BALANCE_STRATEGY` | `least-connections` | Load balancing strategy for distributing requests across inference nodes. One of `random`, `round-robin`, `least-connections`. Can be set to `@dynamic` to take its value from the dashboard. |
| `BACKEND_TIMEOUT_MS` | `300000` | Backend timeout in ms (default: 5 min). For streaming requests this is an idle timeout that resets on each chunk; for non-streaming requests it is a wall-clock deadline. Can be set to `@dynamic` to take its value from the dashboard. |
| `XINITY_INFERENCE_CA` | (unset) | PEM-encoded CA certificate for verifying daemon TLS. When set, gateway connects to daemons via HTTPS. Secret. |

### Deep research

| Variable | Default | Description |
|---|---|---|
| `DEEP_RESEARCH_MAX_STEPS` | `30` | Maximum tool-call steps for deep research mode. |
| `DEEP_RESEARCH_COMPACTION_THRESHOLD` | `0.7` | Fraction of model context window at which compaction triggers. |

### Other

| Variable | Default | Description |
|---|---|---|
| `XINITY_SECRET_KEY` | (unset) | 32 bytes of base64 (openssl rand -base64 32) encrypting dashboard-managed secrets at rest. The same value on every host that sets or reads one. Secret. |
| `XINITY_SECRET_KEY_PREVIOUS` | (unset) | The key XINITY_SECRET_KEY replaced, accepted for decryption only. Set during a rotation, removed once every value has been re-sealed. Secret. |

<!-- [/sync:config] -->

Inference routes are exempt from `IDLE_TIMEOUT` and bounded by `BACKEND_TIMEOUT_MS` instead, so a long generation is not cut off mid-request.

## Build

```bash
bun run build
```
