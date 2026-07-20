# Gateway

The API gateway is the public entry point for all inference requests. It provides an OpenAI-compatible API, routes traffic across inference nodes, records usage, and exposes Prometheus metrics.

For configuration and development setup, see the [gateway README](../../packages/xinity-ai-gateway/README.md). For endpoint-level API documentation, see the live reference at `https://your-gateway/docs`.

## Load Balancing

Three strategies are available, configured via `LOAD_BALANCE_STRATEGY` (default: `least-connections`):

| Strategy | Behavior |
|---|---|
| `least-connections` | Picks the node with the fewest in-flight requests (tracked in Redis). Falls back to random on Redis errors. |
| `round-robin` | Atomic Redis counter per model, rotating through nodes. Falls back to random on Redis errors. |
| `random` | Uniform random selection. No Redis dependency. |

### Prefix-cache affinity

For `least-connections` and `random`, the gateway hashes conversation message prefixes and stores the mapping in Redis for 5 minutes. Repeat conversations are routed to the same node when possible, improving KV cache hit rates on the inference engine.

With `least-connections`, the affinity hint is only honored if the hinted node's connection count is within 2 of the least-loaded node.

## Canary Deployments

A deployment can specify an "early" (canary) model alongside the primary model. Traffic is split based on a progress percentage.

| Mode | How it works |
|---|---|
| **Manual** | Progress stays at the configured value until changed. |
| **Time-based** | Progress interpolates linearly from the starting value toward 100 over a configured time window. After the window expires, all traffic moves to the primary model. |

Canary deployments are configured through the [dashboard's Model Hub](dashboard.md#model-hub).

## Request Recording

Every API call is recorded in the database with input/output messages, model, duration, token counts, API key, application, and organization. Two controls suppress recording of the call body (usage events are always recorded regardless):

- **Per-request:** Set `"store": false` in the request body.
- **Per-key:** Disable the `collectData` flag on the API key (via the dashboard).

## Responses API

The gateway implements the OpenAI Responses API at `/v1/responses`:

- Streaming and non-streaming modes.
- Background execution (returns 202 immediately, stores the result in Redis).
- Conversation continuity via `previous_response_id`.
- Built-in `web_search` tool (supports Google, Bing, Brave, Tavily, Serper, and SearXNG) and `web_fetch` tool with SSRF protection.
- Function tools (model calls them, client receives the calls and can continue via `previous_response_id`).
- Structured output via `text.format` (json_object, json_schema).
- Reasoning effort control via `reasoning.effort`.

Completed responses are cached in Redis with a configurable TTL (default: 1 hour).

## Deep Research

The Responses API (`POST /v1/responses`) supports a deep research mode. Appending `-deep-research` to the model name activates a multi-step research agent. For example, requesting `llama-3.1-70b-instruct-deep-research` runs research using `llama-3.1-70b-instruct` as the underlying model. This suffix is only recognized by the Responses API.

Deep research always runs in background mode (returns 202 regardless of the `background` field). The model is given `web_search` and `web_fetch` tools and a system prompt that instructs it to break the query into sub-questions, search for sources, fetch full pages, cross-reference claims, and produce a cited report.

### Prerequisites

Web search must be configured (`WEB_SEARCH_PROVIDER` + `WEB_SEARCH_CREDENTIAL`). The model must support tool calling.

### Polling and cancellation

Poll for results with `GET /v1/responses/{id}`. The response object is updated incrementally as the research progresses: each completed tool call appears in the `output` array before the final text is ready.

Cancel a running research session with `POST /v1/responses/{id}/cancel`. The generation stops at the next step boundary (the current LLM call or tool execution finishes before stopping).

### Custom instructions

Pass an `instructions` field in the request body to append guidance to the research system prompt (e.g., "Focus on sources from 2024" or "Write the report in German").

### Context compaction

Long research sessions can exceed the model's context window. When accumulated token usage crosses a configurable fraction of the context limit (`DEEP_RESEARCH_COMPACTION_THRESHOLD`, default: 0.70), the gateway summarizes the conversation so far and replaces the message history with the summary. Research then continues from the summary with a fresh context budget. Token usage from compaction calls is included in the final usage totals.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `DEEP_RESEARCH_MAX_STEPS` | `30` | Maximum tool-call loop iterations per research request |
| `DEEP_RESEARCH_COMPACTION_THRESHOLD` | `0.70` | Fraction of model context window at which compaction triggers |

## Image Storage

When S3 is configured, images in chat requests are uploaded to S3, deduplicated by SHA-256, and stored as compact references in the database. External image URLs are fetched and converted to data URIs before forwarding to inference nodes (which may not have internet access). Supports JPEG, PNG, GIF, WebP, and AVIF up to 40 MB.

## TLS

The gateway supports TLS termination on its listen socket (`XINITY_TLS_CERT` / `XINITY_TLS_KEY`) and custom CA certificates for verifying connections to TLS-enabled daemons (`XINITY_INFERENCE_CA`). Per-node TLS is tracked in the database, and the gateway automatically uses the correct protocol per node.

## Backend Timeout

`BACKEND_TIMEOUT_MS` (default: 5 minutes) controls how long the gateway waits for the inference backend. For streaming requests, it acts as an idle timeout (reset on each chunk). For non-streaming requests, it acts as a wall-clock deadline. Client disconnects abort the backend call immediately in both cases.

## Prometheus Metrics

See [Monitoring](monitoring.md) for the full metrics reference. The gateway exposes request counts, latency histograms, time-to-first-token, token counts, generation throughput, backend errors, and client disconnects at `/metrics`.
