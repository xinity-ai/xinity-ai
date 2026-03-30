# xinity-ai-gateway

API gateway service for Xinity AI. This service depends on Postgres and Redis.
It runs an HTTP server that forwards LLM calls and logs usage and request
metadata to the database.

## Requirements

- Bun >= 1.3
- Local dependencies running via `docker compose up -d` at repo root
- Root `.env` configured (see `example.env`)

## Development

```bash
bun run dev
```

## Architecture notes

- `src/gatewayServer.ts` starts the HTTP server and exposes `/v1/*` OpenAI-style endpoints.
- `src/llm-forward/*` handles request validation, model resolution, and forwarding.
- Call logging writes usage and call metadata directly to the database via
  functions in `src/callLogger.ts`.

## Build

```bash
bun run build
```

## Utilities

Generate a test key:

```bash
bun run genkey
```
