# Architecture

## Overview

Xinity AI is a self-hostable platform for managing and serving specialized AI models on-premises. The system lets organizations deploy, monitor, and query LLMs through an OpenAI-compatible API while maintaining full control over their data and infrastructure.

The architecture follows a shared-database pattern for control-plane coordination: the dashboard, gateway, and tether coordinate deployment and node state through a common PostgreSQL schema rather than calling each other directly. This keeps each service thin and independently deployable while ensuring consistency. Daemons do not connect to the database, they receive desired state and report status through a persistent SSE connection to the tether. The one exception to the "no direct calls" rule is data-plane traffic: the gateway forwards inference requests directly to the daemon, which proxies them to the local inference driver (see [How services connect](#how-services-connect)).

## System diagram

```mermaid
graph TB
    subgraph Clients
        App["Applications"]
        CLI["Xinity CLI"]
        Browser["Browser"]
    end

    subgraph "Control Plane"
        Dashboard["Dashboard<br/><small>SvelteKit UI + oRPC API</small>"]
        NotifSched["Notification Scheduler"]
        DeploySync["Deployment Sync Service"]
        Dashboard --- NotifSched
        Dashboard --- DeploySync
        Tether["Tether<br/><small>SSE bridge to daemons</small>"]
    end

    subgraph "Data Plane"
        Gateway["Gateway<br/><small>OpenAI-compatible API</small>"]
    end

    subgraph "Inference Nodes"
        Daemon1["Daemon"]
        Ollama1["Ollama"]
        VLLM1["vLLM"]
        Daemon1 --> Ollama1
        Daemon1 --> VLLM1

        Daemon2["Daemon"]
        Ollama2["Ollama"]
        Daemon2 --> Ollama2
    end

    subgraph "Shared Infrastructure"
        DB[("PostgreSQL")]
        Redis[("Redis")]
        Infoserver["Info Server<br/><small>Model Catalog</small>"]
        SeaweedFS[("SeaweedFS<br/><small>Object Store</small>")]
    end

    App -->|"OpenAI-compatible<br/>requests"| Gateway
    CLI -->|"REST API"| Dashboard
    Browser --> Dashboard

    Gateway --> Redis
    Gateway --> DB
    Gateway -->|"Forward inference<br/>requests"| Daemon1
    Gateway -->|"Forward inference<br/>requests"| Daemon2
    Gateway -.->|"Resolve model<br/>metadata"| Infoserver
    Gateway -->|"Upload images<br/>(multimodal)"| SeaweedFS

    Dashboard --> DB
    Dashboard -->|"Presigned URLs +<br/>download resolution"| SeaweedFS
    DeploySync --> DB

    Tether --> DB
    Daemon1 -->|"SSE"| Tether
    Daemon2 -->|"SSE"| Tether
    Dashboard -.-> Infoserver
```

## Components

### Dashboard

**Package:** `packages/xinity-ai-dashboard` | **Runtime:** SvelteKit 2 + Svelte 5, compiled to a self-contained binary (Bun runtime embedded)

The dashboard is the central management surface. It serves three distinct roles within a single process:

**User interface:** A web application for administrators and operators. Provides management of users and organizations, viewing and labeling inference data, creating and monitoring model deployments, configuring API keys and applications, and SSO/2FA setup.

**API server:** An oRPC-based API served at two endpoints: `/rpc/[...rest]` (JSON-RPC, used by the frontend) and `/api/[...rest]` (OpenAPI-compatible REST, used by the CLI and external integrations). Procedures cover the full management surface: API keys, applications, deployments, organizations, users, SSO, data labeling, and onboarding.

**Background services:** Two long-running processes start alongside the dashboard server:

- *Deployment sync service:* Runs on startup and every 5 minutes. Reads enabled deployments (desired state), compares against existing model installations (actual state), and plans new installations or removals across available nodes. Node selection is governed by `DEPLOYMENT_STRATEGY`: `first-fit` (first node that fits, deterministic), `balanced` (most absolute free VRAM, spreads load for HA; the default), `bin-pack` (tightest fit, consolidates so idle nodes stay drainable), or `proportional` (lowest percent utilization, fair spread across heterogeneous nodes). Writes changes to the `modelInstallation` table, which daemons then act on. Triggered immediately on deployment create/update/delete.

- *Notification scheduler:* Polls every 5 minutes and fires notifications based on system state transitions: deployment readiness or failure, node online/offline status changes, capacity warnings (when usage exceeds 80% of available capacity), and a weekly usage report (sent Monday mornings with deployment counts, node counts, API call volumes, and top models).

**MCP server:** The dashboard exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/mcp`, allowing AI assistants (Claude, Cursor, Windsurf) to manage deployments, applications, API keys, and other resources via natural language. The MCP server dynamically generates its tool list from oRPC procedures at startup — any procedure not explicitly excluded is automatically available as an MCP tool. Security-sensitive operations (credential management, SSO configuration, organization deletion, instance admin) are excluded. Authentication uses the same API keys as the REST API. The endpoint can be disabled with `MCP_ENABLED=false`.

Auth is handled by Better Auth with plugins for 2FA (TOTP), passkeys (WebAuthn), SSO (OIDC), API keys, and multi-tenant organizations. Six roles control access: owner, admin, member, labeler, viewer, and pending (see [Authentication](features/authentication.md#rbac-role-based-access-control)). SSO and the member/labeler/viewer roles are gated behind license features; see the [security whitepaper](legal/security-whitepaper.md) for licensing details.

### Gateway

**Package:** `packages/xinity-ai-gateway` | **Runtime:** Bun native HTTP server

The gateway is the data-plane entry point for all inference traffic. It exposes an OpenAI-compatible API surface:

- `POST /v1/chat/completions`: Chat (streaming and non-streaming)
- `POST /v1/completions`: Legacy text completions
- `POST /v1/embeddings`: Embedding generation
- `POST /v1/rerank`: Reranking
- `POST /v1/audio/transcriptions`: Audio transcription
- `GET /v1/models`: List available models
- `POST /v1/responses`: Responses API (with response caching)

**Request flow:**

1. **Authentication:** The `Authorization: Bearer <key>` header is parsed. The first 25 characters are used as a specifier for fast lookup (cached in Redis for 120 seconds). The full key is verified against a hash stored in the database.
2. **Model resolution:** The requested model name is resolved through the `modelDeployment` table to determine the actual model specifier. For canary deployments, the gateway probabilistically routes between the current and canary model based on time-interpolated progress.
3. **Host selection:** Available inference nodes are fetched from `modelInstallation` joined with `aiNode` and `modelInstallationState`, filtered to installations in the `ready` state. A load balancer selects the target host using one of three strategies: random, round-robin, or least-connections (default).
4. **Image extraction:** For multimodal requests containing image content, each image is extracted and uploaded to SeaweedFS (when configured). The SHA-256 hash of the raw bytes serves as the S3 key and deduplication identifier. A compact `xinity-media://{sha256}` reference is stored in the database log, while the inference node always receives full data URIs. External image URLs are fetched and resolved to data URIs before forwarding. When SeaweedFS is not configured, data URIs are stripped from the database log and external URLs are stored as-is.
5. **Forwarding:** The request is forwarded over HTTP(S) to the selected node's daemon, authenticated with the daemon's per-node token. The daemon proxies it to the local inference driver (Ollama or vLLM) via a plain HTTP passthrough. See [TLS](./security/tls.md) for the daemon proxy's auth and encryption model.
6. **Logging:** On completion, a `usageEvent` row is always written for usage tracking, and (unless suppressed per-request or by the API key's `collectData` flag) a full `apiCall` record is also written for data labeling and review.

**Redis** is used for: authentication caching, load balancer state (counters, connection gauges, affinity keys), and the responses API store.

### Tether

**Package:** `packages/xinity-tether` | **Runtime:** Bun HTTP server

The tether is the bridge between the database and the daemon fleet. Daemons do not connect to PostgreSQL. They maintain a persistent SSE connection to the tether, which handles registration, desired-state streaming, and status collection.

**SSE endpoint (`POST /api/v1/stream`):** A daemon authenticates with a shared secret, sends its hardware profile (GPUs, drivers, capacity) as the request body, and receives a `text/event-stream` response. The tether upserts the node's `aiNode` record, marks it `available = true`, and pushes the initial desired state (the node's `modelInstallation` rows). The connection stays open indefinitely. Keepalives (default every 15s) prevent idle timeouts.

**Desired-state push:** The tether subscribes to a single PostgreSQL `NOTIFY` channel, `model_installation`, no matter how many daemons are connected. When the dashboard changes a deployment (creating or removing `modelInstallation` rows), the trigger fires with the affected node id as its payload, and the tether pushes that node's updated desired state over its SSE stream. Pushes are coalesced over a short window, so a burst of row changes results in one push per node. No polling.

**Status collection (`POST /api/v1/status`):** Daemons report installation lifecycle state changes (downloading, installing, ready, failed) back to the tether, which batches and upserts them into `modelInstallationState`.

**Liveness:** When a daemon disconnects or fails to respond within `LIVENESS_TIMEOUT_MS` (default 45s), the tether sets `available = false` on the node's `aiNode` row. The gateway's next query will no longer route to that node.

**Protocol versioning:** A SHA-256 fingerprint of the Zod wire schemas is exchanged on connect. Version-mismatched daemons are rejected with HTTP 409, preventing silent deserialization failures after upgrades.

### Daemon

**Package:** `packages/xinity-ai-daemon` | **Runtime:** Bun, runs on each inference node

The daemon is a lightweight process that runs on every machine with inference hardware. It connects to the tether via SSE, receives desired state, and drives local inference backends to match.

**Node registration:** On startup, the daemon detects the hardware profile of the machine. It probes for NVIDIA GPUs (via `nvidia-smi`), AMD GPUs (via sysfs or `rocm-smi`), and Intel GPUs (via `xpu-smi`). Total VRAM across all GPUs becomes the node's estimated capacity. If GPUs are found but report no VRAM (unified memory architectures), system RAM is used instead. With no GPUs, the node runs in CPU-only mode. The daemon sends its registration (host, port, GPU details, drivers, capacity) to the tether as the SSE connection body.

**Model lifecycle management:** When the tether pushes a new desired state over the SSE stream, the daemon compares it against what is actually running locally:

1. For **Ollama**: pulls missing models (streaming progress back to the tether), removes models no longer needed. Supports 2 concurrent pulls.
2. For **vLLM**: manages model instances via systemd template units or Docker containers. Starts new instances, stops stale ones, and polls health endpoints until the model is ready (up to 1 hour timeout). Fires a warmup request on readiness to pre-compile Triton kernels.
3. Reports lifecycle state (`downloading` → `installing` → `ready` / `failed`) back to the tether, which writes it to `modelInstallationState`.

The daemon has no direct database connection. All coordination flows through the tether's SSE channel and status endpoint.

### Xinity CLI

**Package:** `packages/xinity-cli` | **Runtime:** Standalone compiled binary

The CLI is the operator's tool for installing, configuring, and managing Xinity services on Linux hosts. Key capabilities:

- **`xinity up <component>`**: Installs or updates gateway, dashboard, daemon, tether, infoserver, or database. Handles the full lifecycle: downloads the binary from GitHub Releases with SHA256 verification, prompts for environment configuration (reading Zod schemas from each component's `env-schema.ts`), generates systemd unit files with security hardening, and starts the service. Supports `--target-host` for remote installation over SSH. The `db` subcommand also bundles Redis discovery after running Postgres migrations.
- **`xinity up infra-<tool>`**: Infrastructure setup utilities for dependencies like Redis, SeaweedFS, Postgres, and Ollama. These handle detection, installation, service management, and configuration. For example, `infra-ollama` installs ollama (left on its default localhost binding, since it runs alongside the daemon on the same host) and confirms the endpoint answers. Nothing is written to the daemon env file: the daemon probes that address itself and enables the ollama driver whenever it responds.
- **`xinity rm <component>`**: Cleanly removes a component (stops service, removes unit file, binary, and config). Preserves secrets that are still needed by other installed components.
- **`xinity update`**: Self-updates the CLI binary.
- **`xinity act [route] [data]`**: Calls any dashboard API route directly. Dynamically discovers available routes by loading the dashboard's oRPC router at runtime. Supports interactive schema-driven prompts when data is omitted.
- **`xinity configure`**: Manages CLI settings or interactively reconfigures components when run as `xinity configure <component>`.

The CLI generates systemd units with a security-conscious split: non-secret environment variables go into a readable env file, while secrets (annotated with `.meta(secret())` in the schema) are stored in mode-600 files and loaded via systemd's `LoadCredential`.

### Common DB

**Package:** `packages/common-db`

The shared database layer. Contains the Drizzle ORM schema, migrations, and utilities that every other service depends on. Key tables include:

| Table | Purpose |
|---|---|
| `user`, `account`, `session` | Better Auth identity and session management |
| `organization`, `member`, `invitation` | Multi-tenant organization structure |
| `aiApiKey` | Gateway API keys (specifier prefix + hash) |
| `aiApplication` | Named application groupings for API keys |
| `modelDeployment` | Desired state: which models should be available, with canary controls |
| `aiNode` | Registered inference nodes with capacity, drivers, and availability |
| `modelInstallation` | Planned model instances per node (written by dashboard, read by daemons and gateway) |
| `modelInstallationState` | Actual lifecycle state per installation (written by daemons, read by dashboard and gateway, which filters host selection to `ready` installations) |
| `usageEvent` / `usageSummary` | Unconditional per-call usage records and their rolled-up summaries, used for usage tracking and billing (in `call_data` schema) |
| `apiCall` | Full logged inference requests, gated by the API key's `collectData` flag, used for data labeling and review (in `call_data` schema) |
| `apiCallResponse` | User feedback and labels on logged calls |
| `mediaObject` | Metadata for images uploaded to SeaweedFS: sha256, mimeType, s3Key, org scoping (in `call_data` schema) |

The package also provides `preconfigureDB()`, which returns lazy database access with a migration check gate, so services cannot query the database until migrations are confirmed up to date.

### SeaweedFS

**External service** | **Managed by:** `xinity up infra-seaweedfs`

SeaweedFS is an optional self-hosted S3-compatible object store used for multimodal image storage. It replaces the alternative of embedding base64 image data directly in the PostgreSQL `apiCall.inputMessages` JSONB column, which would cause significant database bloat.

When `S3_ENDPOINT` is configured in the gateway:

- Incoming image content (data URIs and external URLs) is uploaded to SeaweedFS, keyed by the SHA-256 hash of the raw bytes.
- The database stores a compact `xinity-media://{sha256}` reference inside the existing `image_url` content part.
- Inference nodes always receive full data URIs (external URLs are fetched and resolved before forwarding).
- The `mediaObject` table records sha256, MIME type, S3 bucket/key, organization ID, and byte size. The unique constraint on `(organizationId, sha256)` provides content-addressed deduplication.

The dashboard resolves `xinity-media://` references:
- **Display:** A server-side `/data/media/[sha256]` endpoint generates a short-lived presigned URL (15 minutes) and returns a 302 redirect.
- **Export:** The `/data/export/[callId]` endpoint resolves references to data URIs before serializing, producing fully self-contained JSON downloads.

SeaweedFS ships as a single static `weed` binary with no external dependencies. It is installed and managed via `xinity up infra-seaweedfs`, which downloads the binary, writes an S3 identity config to `/etc/xinity-ai/seaweedfs-s3.json`, installs a systemd unit, and starts the service. The gateway can also function without SeaweedFS configured, in which case, data URIs are stripped from call logs entirely and external URLs are stored as-is.

### Info Server

**Package:** `packages/xinity-infoserver` | **Runtime:** Bun HTTP server, stateless

A model catalog service that publishes metadata about available models. Reads from a YAML catalog file (with support for recursive remote includes) and serves it as both YAML and JSON. Each model entry includes name, description, weight size, minimum KV cache, type (chat/embedding/rerank/transcription), supported drivers with driver-specific model strings, and tags (e.g. `tools`, `vision`, `custom_code`).

Consumed by the gateway (to resolve model types and driver tags), the daemon (to check tags like `custom_code` for vLLM `--trust-remote-code`), and the dashboard (to display available models for deployment). All consumers use a shared client with in-memory TTL caching.

## How services connect

```mermaid
graph LR
    subgraph "Writes to DB"
        DashW["Dashboard<br/><small>deployments, installations,<br/>users, orgs, API keys</small>"]
        TetherW["Tether<br/><small>node info,<br/>installation state</small>"]
        GatewayW["Gateway<br/><small>API call logs</small>"]
    end

    DB[("PostgreSQL")]

    subgraph "Reads from DB"
        DashR["Dashboard<br/><small>all tables</small>"]
        TetherR["Tether<br/><small>installations per node</small>"]
        GatewayR["Gateway<br/><small>API keys, deployments,<br/>installations, nodes</small>"]
    end

    DashW --> DB
    TetherW --> DB
    GatewayW --> DB
    DB --> DashR
    DB --> TetherR
    DB --> GatewayR
```

Control-plane coordination between the gateway, dashboard, and tether flows through the shared PostgreSQL database. Daemons have no database connection. They communicate exclusively with the tether via SSE. The one direct service-to-service call is data-plane: the gateway forwards inference requests to the daemon.

- **Dashboard → PostgreSQL → Tether → Daemon**: The dashboard writes `modelInstallation` rows (planned state). A PostgreSQL trigger notifies the tether, which pushes updated desired state to the affected daemon over its SSE stream. The daemon drives local drivers to match.
- **Daemon → Tether → PostgreSQL → Dashboard**: The daemon reports installation lifecycle state to the tether via `POST /api/v1/status`. The tether writes it to `modelInstallationState`. The dashboard reads these for status display, orchestration planning, and notification triggers. On connect/disconnect, the tether updates the node's `available` flag in `aiNode`.
- **Gateway → Daemon**: The gateway forwards inference requests directly to the target node's daemon (`/proxy/{model}/v1/...`), authenticated with a per-node token read from `aiNode`. The daemon proxies the request to the local driver on `127.0.0.1`. This is the only direct service-to-service call in the system; see [TLS](./security/tls.md).
- **Gateway → Database**: The gateway reads `aiApiKey` for authentication, `modelDeployment` for model resolution, and `modelInstallation`/`aiNode`/`modelInstallationState` for host selection (filtering to `available = true` nodes with `ready` installations). It writes `usageEvent` rows for usage tracking, and (when the API key's `collectData` flag is set) `apiCall` rows for data labeling. It also listens for row-change notifications on those four tables to invalidate its routing caches.
- **Redis** is used exclusively by the gateway for ephemeral state: auth caching, load balancer coordination, and the responses API store.
- **Info server** is consumed over HTTP by the gateway and dashboard for model metadata resolution, with each consumer maintaining its own in-memory cache.
- **SeaweedFS** (optional) is written to by the gateway on every multimodal request and read by the dashboard for image display (presigned URLs) and call export (data URI resolution). No other services interact with it directly.

## Model deployment lifecycle

```mermaid
sequenceDiagram
    participant Ops as Operator
    participant CLI as Xinity CLI
    participant Info as Info Server
    participant UI as Dashboard
    participant DB as PostgreSQL
    participant Tether as Tether
    participant Daemon as Daemon
    participant Driver as Ollama / vLLM
    participant App as Application
    participant Gateway as Gateway
    participant Redis as Redis

    Ops->>Info: Publish model catalog (YAML)
    Ops->>CLI: xinity up tether / daemon / gateway / dashboard
    CLI->>UI: Configure via dashboard API

    Daemon->>Tether: SSE connect (registration + auth)
    Tether->>DB: Upsert aiNode, set available = true

    UI->>Info: Fetch available models
    UI->>DB: Create modelDeployment (desired state)
    UI->>DB: Plan modelInstallation rows (sync service)
    DB-->>Tether: NOTIFY model_installation
    Tether-->>Daemon: Push desired state (SSE event)

    Daemon->>Driver: Pull / start model
    Daemon->>Tether: Report lifecycle state (POST /api/v1/status)
    Tether->>DB: Upsert modelInstallationState (downloading → ready)

    Note over UI,DB: Dashboard scheduler detects state change,<br/>sends notification to org members

    App->>Gateway: POST /v1/chat/completions
    Gateway->>DB: Verify API key, resolve deployment
    Gateway->>Redis: Check auth cache, load balancer state
    Gateway->>Daemon: Forward request to selected node (/proxy/{model}/v1/...)
    Daemon->>Driver: Proxy to local driver
    Driver-->>Daemon: Response (streamed or complete)
    Daemon-->>Gateway: Response (streamed or complete)
    Gateway-->>App: OpenAI-compatible response
    Gateway->>DB: Log API call asynchronously
```
