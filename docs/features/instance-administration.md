# Instance Administration

Instance administration is available to users whose email appears in the `INSTANCE_ADMIN_EMAILS` environment variable. These features are found under Instance Settings in the dashboard sidebar. For auth and role details, see [Authentication & Authorization](authentication.md).

## User Management

Admins can list all users with search and pagination, and perform the following actions per user:

- **Create users** with a generated temporary password (shown once). The user is auto-verified and must change their password on first login.
- **Ban / unban** users with an optional reason and expiration date.
- **Verify / unverify** email addresses.
- **Reset passwords**, generating a new temporary password.
- **Add users to organizations** with a specified role.
- **Remove users from organizations** (blocked when the user is the sole owner).
- **Change user roles** within an organization (blocked when demoting the sole owner).

## Organization Management

Admins can list all organizations with search and pagination. Each organization entry shows member count, deployment count, and total VRAM capacity. Actions include:

- View and manage member lists (change roles, remove members).
- Toggle **SSO self-management** per organization, allowing org admins to configure their own SSO providers (requires the `sso-self-manage` license feature).

## SSO Provider Management

Instance-level SSO identity providers are configured under Instance Settings > SSO. OIDC providers are supported. When SSO self-management is enabled for an organization, that org's admins can also manage their own providers from the organization settings page.

Each provider requires **domain verification** before users can sign in through it. After registering a provider:

1. Open the "Domain verification" section on the provider card.
2. Add the displayed TXT record to the DNS configuration for the provider's email domain (e.g. `_xinity-sso-<providerId>.<domain>`).
3. Click "Check DNS" once the record has propagated.

Verified providers show a green "Verified" badge. Unverified providers show an amber "Unverified" badge and block sign-in attempts. The verification token persists across page reloads, so the DNS instructions remain visible without restarting the flow.

## License Management

The license page (Instance Settings > License) shows the current license status, tier, licensee, and the deployment instance ID needed when requesting a license.

## Monitoring Setup

The monitoring page generates a ready-to-use `prometheus.yml` configuration with three scrape jobs:

1. **xinity-gateway:** Static target derived from `GATEWAY_URL`.
2. **xinity-dashboard:** Static target derived from the dashboard's `ORIGIN`.
3. **xinity-daemon:** Dynamic target discovery via the dashboard's HTTP service discovery endpoint (`/metrics/sd/daemons`), refreshing every 3 minutes. Nodes are added and removed automatically as daemons come online.

The page also documents the Docker Compose monitoring profile (`docker compose --profile monitoring up -d`) and the `PROMETHEUS_URL` overlay for enabling live GPU utilization on the Compute page.

See [Monitoring](monitoring.md) for full details on metrics, Grafana dashboards, and deployment.
