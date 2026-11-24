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

### Deployment list

The Model Hub lists every deployment of the organization with its public name, model, status and how many of its replicas serve. A canary deployment also shows its traffic split. Each deployment opens on a page of its own with its replicas, its model or rollout, and its settings. Deployments that are still changing refresh often, the rest every two minutes.

### Deployment status

The status runs from fine to broken, so an operator sees at a glance which deployments need them. Those that need them count towards "need attention" in the list.

| Status | Meaning | Needs you |
|---|---|---|
| Healthy | Every replica the deployment asks for runs and answers requests. | |
| Reduced | Answers requests correctly, with fewer replicas than it asks for, because some have no machine or failed. It handles less traffic at once. | |
| Degraded | Answers requests, but not as configured. During a rollout one model has no serving replica, so all traffic goes to the other one whatever the split says, and the rollout cannot be promoted. | Yes |
| Down | It ran, but the machines its replicas ran on went offline and no other machine can take them. Requests to it fail. | Yes |
| Failed | Its replicas failed to start or stopped with an error. Its page shows the error and the logs, and Retry starts them again. | Yes |
| Not placed | Enabled, but no machine has taken it yet, for lack of free memory, of room under the license, or of a machine with the engine the model needs. It is placed on its own once that changes. | Yes |
| Not in Catalog | The model catalog no longer lists its model, so it cannot be placed. Change it to a model the catalog has. | Yes |
| Scheduling, Downloading, Installing | On its way to serving. | |
| Disabled | Runs nowhere, and requests to it fail. | |

A single replica shows Serving, Failed, Scheduling, Downloading or Installing, or Not scheduled when it has no machine.

### Creating a deployment

"Deploy a model" takes two steps. First a model is chosen from the catalog. Then it is set up: a name and the public name requests use, the replicas and KV cache, and settings such as what to optimize for. The page shows where the deployment would run, against the memory free on the machines and the room left under the license. A deployment that does not fit now can be saved disabled and enabled later. Models with a restricted license or with `custom_code` need explicit consent.

### Changing the model

The model of a running deployment changes on the deployment's page. Switching at once stops serving until the new model is installed. A rollout instead runs both models side by side and splits traffic between them, moving it by hand or evenly over a number of hours. A rollout runs on at least two replicas, one per model. A rollout never ends on its own. At 100%, Promote finishes it with the new model, and Roll back returns all traffic to the old one and removes the new model.

### Inline testing

While a deployment serves, its page has a Test button that opens the test fitting its model:

- **Chat:** Multi-turn streaming conversation with reasoning content display.
- **Embedding:** Single text input returning the vector with dimensions and token stats.
- **Rerank:** Query plus documents, returning ranked results with relevance scores.

## Compute Dashboard

Real-time view of all GPU compute nodes (under Instance Settings > Compute). Shows summary stats: machines online, GPU count, compute load, tokens processed, energy consumption, and success rate. Per-node cards display GPU utilization rings, model badges with lifecycle states, and token/energy/success metrics. Auto-polls every 12 seconds.

Requires Prometheus (`PROMETHEUS_URL`) for live utilization and energy readings. See [Monitoring](monitoring.md) for setup.

## Data Management

Data is organized by **applications.** Each application groups API calls made with API keys scoped to it. Calls without an application appear in an "Uncategorized" section (use the `X-Application` header to route calls).

### Filtering and search

Within an application: full-text search, API key filter, reaction filter (all/has reactions/no reactions/liked/disliked/my reactions/my likes/my dislikes), metadata key/value filter, and sorting by time or duration. Infinite scroll pagination.

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
| **AI API keys** | Gateway inference API | AI API Keys page |
| **Dashboard API keys** | Dashboard REST API, MCP server | Settings > Authentication |

AI API keys can be scoped to specific applications. The AI API Keys page includes code examples (Python, curl, Node.js).

Deactivating or deleting an AI API key, or changing whether its calls are recorded, takes effect within 2 minutes with the default gateway settings.

## In-Dashboard Documentation

The dashboard includes built-in docs covering: quick start, access methods, API reference, applications, code examples, deployment troubleshooting, inference drivers, labeling guide, roles, and SSO configuration.

## Onboarding

New users see a setup wizard that creates an organization and deploys a first model in one step, generating an API key. A persistent, dismissible checklist tracks six milestones: create an organization, deploy a model, make an API call, label a call, invite a team member, and create an application.
