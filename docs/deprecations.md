# Deprecations

Entries without a removal release still work, but go away in a future release. Until then, a service whose install still depends on one reports it in the details of its [`/health` endpoint](features/monitoring.md#details), with what still uses it and how to move off.

The CLI reads those reports:

- `xinity doctor` shows each one as a warning.
- `xinity up` and `xinity stack up` list the ones the target release removes before updating, and only continue on a confirmation. A service whose report cannot be read, because it has no `METRICS_AUTH`, listens on a unix socket, is unreachable, or predates the reports, is named as not checked.

Updates through Docker Compose or NixOS are not checked. Before one, read the `/health` details of the running services yourself.

<!-- [sync:deprecations] - generated from the deprecation registry, do not edit -->

| Removed in | Deprecated since | ID | What changes |
|---|---|---|---|
|  | 2026-07-22 | `gateway.web-search-engine-url` | WEB_SEARCH_ENGINE_URL is no longer read. WEB_SEARCH_PROVIDER and WEB_SEARCH_CREDENTIAL replace it. |
|  | 2026-08-04 | `infoserver.legacy-model-dir` | MODEL_LEGACY_DIR and the v1 catalog endpoints are removed. |
|  | 2026-08-05 | `deployments.legacy-catalog` | Deployments can no longer resolve their model through the v1 catalog. |
|  | 2026-09-01 | `dashboard.legacy-api-calls` | The legacy api_call table is dropped along with any calls still in it. |
| 0.25.0 | 2026-05-07 | `nix.dashboard-better-auth-url` | The NixOS option services.xinity-ai-dashboard.betterAuthUrl is gone. origin replaces it. |
| 0.22.0 | 2026-05-07 | `dashboard.better-auth-url` | BETTER_AUTH_URL is no longer read. ORIGIN is the auth base URL. |
| 0.22.0 | 2026-05-07 | `deployments.provider-model-specifiers` | Deployments and installations are identified by their canonical specifier only. The provider model columns, the modelSpecifier and earlyModelSpecifier API fields, the infoserver ?lookup= parameter and the gateway's provider model fallback are gone. |
| 0.22.0 | 2026-04-23 | `infoserver.model-info-file` | MODEL_INFO_FILE is no longer read. MODEL_INFO_DIR replaces it. |
| 0.22.0 | 2026-04-29 | `dashboard.public-llm-api-url` | PUBLIC_LLM_API_URL is no longer read. GATEWAY_URL replaces it, without the /v1 suffix. |
| 0.22.0 | 2026-05-16 | `daemon.ai-node-drivers` | The ai_node.drivers column is dropped. Driver features and versions replace it. |
| 0.19.1 |  | `nix.dashboard-public-llm-api-url` | The NixOS option services.xinity-ai-dashboard.publicLlmApiUrl is gone. gatewayUrl replaces it, without the /v1 suffix. |

<!-- [/sync:deprecations] -->
