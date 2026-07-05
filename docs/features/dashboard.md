# Dashboard

The SvelteKit admin dashboard provides a web UI for managing models, viewing analytics, labeling data, and administering the platform.

For development setup and project structure, see the [dashboard README](../../packages/xinity-ai-dashboard/README.md). For auth and access control, see [Authentication & Authorization](authentication.md). For instance-level admin features, see [Instance Administration](instance-administration.md).

## Home Page

The landing page shows a summary of platform activity:

- **Metric cards:** Total API calls (with today's count and logging percentage), average tokens per call at three time windows (1m, 10m, 1h), approval rate with average response time, and training datapoint counts.
- **Usage trend chart:** 30-day dual-axis chart showing total calls, logged calls, input tokens, and output tokens.
- **Response ratings:** Doughnut chart of liked, disliked, and unrated responses.
- **Application usage:** Bar chart of the top 5 applications by call count.
- **Recent activities and deployed models** tables with quick links.

Historical usage events older than 30 days are automatically rolled up into daily summaries.

## Model Hub

The Model Hub manages model deployments across the cluster.

### Deployment cards

Each card shows status (Ready, Partial, Failed, Scheduling, Downloading, Installing, Not in Catalog), public specifier, replica count, deployment type (Static or Canary with mode), and failure logs. Multi-replica deployments show per-replica status dots. Canary deployments display a traffic distribution bar. Deployments in transient states auto-refresh every 10 seconds.

### Creating a deployment

The deployment modal walks through: model selection from the catalog, public specifier and display name, optional canary configuration (canary model, initial traffic split, manual or time-based advancement), and expert settings (replicas, KV cache size, preferred driver). A capacity check runs before submission. Models with `custom_code` require explicit consent.

### Inline testing

Three test modals are available from deployment cards:

- **Chat:** Multi-turn streaming conversation with reasoning content display.
- **Embedding:** Single text input returning the vector with dimensions and token stats.
- **Rerank:** Query plus documents, returning ranked results with relevance scores.

## Compute Dashboard

Real-time view of all GPU compute nodes (under Instance Settings > Compute). Shows summary stats: machines online, GPU count, compute load, tokens processed, energy consumption, and success rate. Per-node cards display GPU utilization rings, model badges with lifecycle states, and token/energy/success metrics. Auto-polls every 12 seconds.

Requires Prometheus (`PROMETHEUS_URL`) for live utilization and energy readings. See [Monitoring](monitoring.md) for setup.

## Data Management

Data is organized by **applications.** Each application groups API calls made with API keys scoped to it. Calls without an application appear in an "Uncategorized" section (use the `X-Application` header to route calls).

### Filtering and search

Within an application: full-text search, API key filter, reaction filter (liked/disliked/unrated/my reactions), metadata key/value filter, and sorting by time or duration. Infinite scroll pagination.

### Labeling

Labeling prepares data for fine-tuning:

- **Rating:** Thumbs-up or thumbs-down on responses.
- **Editing:** Write an ideal output in the "Edit" tab. Auto-saves after 30 seconds.
- **Highlighting:** Drag-select text to mark it as positive (green) or negative (red).
- **Input exclusions:** Toggle entire messages or select specific text ranges to exclude from training.

The `labeler` [RBAC role](authentication.md#rbac-role-based-access-control) grants access to all labeling features without access to deployments or API key management.

### Export

Individual calls can be exported as self-contained JSON files. Image references are resolved to inline base64 data URIs.

## API Key Management

Two types of API keys:

| Key type | Scope | Managed at |
|---|---|---|
| **AI API keys** | Gateway inference API, MCP server | AI API Keys page |
| **Dashboard API keys** | Dashboard REST API | Settings > Authentication |

AI API keys can be scoped to specific applications. The AI API Keys page includes code examples (Python, curl, Node.js).

## In-Dashboard Documentation

The dashboard includes built-in docs covering: quick start, access methods, API reference, applications, code examples, deployment troubleshooting, inference drivers, labeling guide, roles, and SSO configuration.

## Onboarding

New users see a setup wizard that creates an organization and deploys a first model in one step, generating an API key. A persistent, dismissible checklist tracks six milestones: create an organization, deploy a model, make an API call, label a call, invite a team member, and create an application.
