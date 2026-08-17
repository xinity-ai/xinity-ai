# Audit Trail

The dashboard keeps an append-only record of security-relevant actions in the `audit_event` table. Recording is always on and needs no configuration. Viewing and exporting the trail requires a license carrying the `audit-log` feature, so an unlicensed instance still accumulates a complete record and can read it later once licensed.

Events can additionally be mirrored to Loki, which is covered under [Forwarding to Loki](#forwarding-to-loki).

## What is recorded

| Field | Description |
|---|---|
| `id` | Event UUID |
| `createdAt` | Timestamp, the sort and pagination key |
| `organizationId` | Owning organization, or null for instance-scoped and personal events |
| `actorType` | `user`, `api_key`, `system`, or `instance_admin` |
| `actorId` | User id or API key id |
| `actorLabel` | Email or key name, denormalized so the record stays readable after the principal is deleted |
| `action` | `resource.verb`, see [Audited actions](#audited-actions) |
| `resource` | Resource family the action touched |
| `resourceId` | The specific entity, when known |
| `result` | `success` or `failure` |
| `ipAddress` | Client address, see [Client addresses behind a proxy](#client-addresses-behind-a-proxy) |
| `userAgent` | Client user agent |
| `context` | JSON detail: the transport `channel`, selected input and output fields, and the error message on a failure |

A failed action is recorded as well as a successful one, with `result: "failure"` and the error message in `context.error`. Recording never delays or breaks the action it describes.

## Audited actions

51 actions across 13 resource families.

| Family | Actions |
|---|---|
| `account` | `change_password`, `create_dashboard_api_key`, `delete_dashboard_api_key`, `delete_passkey`, `disable_2fa`, `enable_2fa`, `request_password_reset`, `sign_in`, `sign_in_sso`, `sign_out`, `sign_up`, `verify_email` |
| `instanceAdmin` | `add_user_to_org`, `ban_user`, `create_user`, `remove_user_from_org`, `reset_user_password`, `set_email_verified`, `set_sso_self_manage`, `unban_user`, `update_user_role` |
| `apiKey` | `create`, `delete`, `toggle_collect_data`, `toggle_enabled`, `update` |
| `modelDeployment` | `create`, `delete`, `retry`, `toggle_enabled`, `update` |
| `aiApplication` | `create`, `delete`, `update` |
| `apiCall` | `delete`, `reassign_application`, `update_metadata` |
| `organization` | `create`, `delete`, `update` |
| `sso` | `delete_provider`, `register_oidc`, `register_saml` |
| `invitation` | `cancel`, `create` |
| `member` | `remove`, `update_role` |
| `onboarding` | `cli`, `setup` |
| `compute` | `remove_node` |
| `user` | `update_settings` |

### Authentication flows

Sign-in, sign-up, sign-out, email verification, password reset and 2FA changes are recorded as `account.*` events. They are always personal scope, with no organization and no `context` detail. Among them only `account.sign_in` records failures, which is what makes failed login attempts visible.

## Transport channel

Because the same procedures are reachable three ways, each event records how the call arrived in `context.channel`:

| Channel | Source |
|---|---|
| `rpc` | `/rpc`, which is what the dashboard UI uses |
| `api` | `/api`, the OpenAPI-compatible REST surface |
| `mcp` | `/mcp`, the Model Context Protocol endpoint |

Combining `actorType` with `channel` answers the questions that matter in practice: `actorType: "api_key"` tells you a key acted rather than a person, `actorLabel` names the key, and `channel` distinguishes a REST integration from an MCP client. Note that the audit procedures themselves are excluded from the MCP tool list, so the trail cannot be read over MCP.

## Access

Two independent gates apply.

- **License.** `audit.list` and `audit.export` return `FORBIDDEN` unless the license carries the `audit-log` feature. The sidebar entry and page are hidden without it.
- **Role.** `auditLog: ["read"]` belongs to **owner** and **admin** only. It is deliberately excluded from `member`, so full members cannot read the trail.

Instance admins get an extra **instance-wide** toggle that widens results to include events with no organization, covering instance administration and personal auth activity. The toggle has no effect for anyone who is not an instance admin.

## Viewing and exporting

The trail lives at `/audit`, where you can filter by action, result, actor id, and a from/to date range, and expand any row to see its full `context` JSON. The page loads 50 events at a time.

`audit.list` is cursor-paginated on `createdAt`, newest first, and accepts up to 100 rows per request. It also takes a `resource` filter that the page does not expose, since the action dropdown already groups actions by resource.

Export is available as NDJSON or CSV over `audit.export`, which requires a `from` date and is **capped at 10,000 rows**. The response carries a `truncated` flag when the cap is hit, and the UI surfaces a warning telling you to narrow the range. An export is ordered oldest first, while the list view is newest first.

## Client addresses behind a proxy

`ipAddress` comes from the connection unless a proxy header is configured. Behind a reverse proxy the recorded address is the proxy's, which makes the field useless for attribution, so set:

| Variable | Purpose |
|---|---|
| `HTTP_IP_HEADER` | Header the proxy forwards the client IP in, for example `x-forwarded-for` or `x-real-ip` |
| `HTTP_XFF_DEPTH` | With `x-forwarded-for`, how many proxy hops to skip from the right. 1 for a single proxy, 2 for two chained |

## Forwarding to Loki

Every persisted event can be mirrored to Loki for querying alongside service logs. The database stays authoritative, and the mirror is best effort.

| Variable | Purpose |
|---|---|
| `AUDIT_LOKI_URL` | Loki base URL, for example `http://localhost:6122`. Unset means no forwarding |
| `AUDIT_LOKI_AUTH` | Basic auth as `user:pass`, only for an authenticated endpoint |
| `AUDIT_LOKI_TENANT` | Tenant id sent as `X-Scope-OrgID`, for multi-tenant Loki or Grafana Cloud |

Forwarding also requires the `audit-log` feature, so an unlicensed instance never pushes.

Events are batched, flushing at 100 events or 5 seconds, whichever comes first, and are flushed again during shutdown so a restart does not discard the current batch.

Query them under `{job="xinity-audit"}`. `action`, `resource` and `result` are stream labels, so they can be used as selectors. Everything else, including actor and context, lives in the log line and needs `| json`.

If Loki is unreachable the affected events are logged at error level with the time range they cover, and never reach the mirror. The database still holds them, so that range is what you would re-query for a complete picture.

### NixOS

The dashboard module exposes `auditLokiUrl` and `auditLokiTenant`. The all-in-one module points the forwarder at the bundled Loki automatically when `monitoring.logs.enable = true`, so no explicit configuration is needed there.

### Grafana

The **Xinity Logs** dashboard carries an Audit trail row with events broken down by action and the event stream itself. It is provisioned by the NixOS monitoring module when `logs.enable = true`. See [Monitoring](monitoring.md).
