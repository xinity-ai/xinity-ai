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

| Variable | Default | Description |
|---|---|---|
| `HOST` | `localhost` | Bind address |
| `PORT` | `4010` | Listen port |
| `UNIX_SOCKET` | (unset) | Unix socket path (overrides HOST/PORT) |
| `DB_CONNECTION_URL` | (required) | PostgreSQL connection string |
| `REDIS_URL` | (required) | Redis connection URL |
| `INFOSERVER_URL` | `https://sysinfo.xinity.ai` | Infoserver URL |
| `LOAD_BALANCE_STRATEGY` | `least-connections` | `random`, `round-robin`, or `least-connections` |
| `BACKEND_TIMEOUT_MS` | `300000` | Backend timeout in ms. Idle timeout for streaming, wall-clock for non-streaming. |
| `WEB_SEARCH_PROVIDER` | (unset) | Web search backend: `searxng`, `google`, `bing`, `brave`, `serper`, or `tavily`. Web search is disabled when unset. |
| `WEB_SEARCH_CREDENTIAL` | (unset) | Provider credential: instance URL for SearXNG, `apikey:cx` for Google, API key for Bing/Brave/Serper/Tavily |
| `WEB_SEARCH_ENGINE_URL` | (unset) | **Deprecated.** Use `WEB_SEARCH_PROVIDER` + `WEB_SEARCH_CREDENTIAL` instead. Falls back to SearXNG when set. |
| `DEEP_RESEARCH_MAX_STEPS` | `30` | Maximum tool-call loop iterations per deep research request |
| `DEEP_RESEARCH_COMPACTION_THRESHOLD` | `0.70` | Fraction of model context window at which deep research compaction triggers |
| `RESPONSE_CACHE_TTL_SECONDS` | `3600` | Responses API Redis cache TTL |
| `INFOSERVER_CACHE_TTL_MS` | `600000` | How long the local catalog snapshot is trusted before revalidating, in ms |
| `METRICS_AUTH` | (unset) | Basic auth for `/metrics` (format: `user:pass`, comma-separated for multiple) |
| `IDLE_TIMEOUT` | `255` | Server-level idle connection timeout in seconds |

### S3 (image storage)

All three must be set to enable multimodal image storage.

| Variable | Default | Description |
|---|---|---|
| `S3_ENDPOINT` | (unset) | S3-compatible endpoint (e.g., SeaweedFS) |
| `S3_ACCESS_KEY_ID` | (unset) | S3 access key |
| `S3_SECRET_ACCESS_KEY` | (unset) | S3 secret key |
| `S3_BUCKET` | `xinity-media` | S3 bucket name |
| `S3_REGION` | `us-east-1` | S3 region (use `us-east-1` for SeaweedFS) |

### TLS

| Variable | Description |
|---|---|
| `XINITY_TLS_CERT` | PEM-encoded TLS certificate for the gateway's listen socket |
| `XINITY_TLS_KEY` | PEM-encoded TLS private key (must be set together with cert) |
| `XINITY_INFERENCE_CA` | PEM-encoded CA certificate for verifying TLS connections to daemons |

## Build

```bash
bun run build
```
