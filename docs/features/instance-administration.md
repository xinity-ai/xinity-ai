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
- Toggle **SSO self-management** per organization, allowing org admins to configure their own SSO providers. The toggle itself has no license requirement, but org admins can only actually manage providers if the instance has the `sso-self-manage` license feature.

## SSO Provider Management

Instance-level SSO identity providers are configured under Instance Settings > SSO. OIDC providers are supported. When SSO self-management is enabled for an organization, that org's admins can also manage their own providers from the organization settings page.

Each provider requires **domain verification** before users can sign in through it. After registering a provider:

1. Open the "Domain verification" section on the provider card.
2. Add the displayed TXT record to the DNS configuration for the provider's email domain (e.g. `_xinity-sso-<providerId>.<domain>`).
3. Click "Check DNS" once the record has propagated.

Verified providers show a green "Verified" badge. Unverified providers show an amber "Unverified" badge and block sign-in attempts. The verification token persists across page reloads, so the DNS instructions remain visible without restarting the flow.

## License Management

The license page (Instance Settings > License) shows the current license status, tier, licensee, and the deployment instance ID needed when requesting a license.

## Dynamic Configuration

Selected settings can be changed from Instance Settings > Configuration and take effect without restarting anything. Three things must line up before a value there is used:

1. The setting is declared as dashboard-managed by the service that reads it. The per-package README marks these.
2. The deployment delegated it, by starting the component with `KEY=@dynamic` or `KEY=@dynamic:<fallback>` instead of a literal value.
3. A value is set on the page.

The fallback form is the safe way to adopt one. `LOAD_BALANCE_STRATEGY=@dynamic:round-robin` behaves exactly as `LOAD_BALANCE_STRATEGY=round-robin` did until somebody sets a value on the page, so nothing changes on the next restart.

Clearing a value returns each component to the fallback it was started with, which can differ between hosts. The page cannot show what that is, only the value the schema declares.

A component that was not started with `@dynamic` for a setting ignores whatever is on the page, and a component refuses to start if it is given `@dynamic` for a setting that is not dashboard-managed.

How a component gets delegated depends on how it is deployed. The CLI offers "manage from dashboard" in its configuration menu, which keeps the current value as the fallback. A Docker Compose or systemd deployment writes the sentinel into its environment file by hand. A NixOS deployment lists the env keys under `services.<service>.dashboardManaged`, which keeps every typed option as it was and emits it as its own fallback:

```nix
services.xinity-ai-gateway = {
  loadBalanceStrategy = "round-robin";
  dashboardManaged = [ "LOAD_BALANCE_STRATEGY" "RESPONSE_CACHE_TTL_SECONDS" ];
};
```

### Secrets

Some dashboard-managed settings are secrets, marked as such on the page. They are encrypted before they are stored, with `XINITY_SECRET_KEY`: 32 bytes of base64 from `openssl rand -base64 32`, the same value on every host that sets or reads one.

**The gateway, dashboard and daemon require it and refuse to start without one**, or with a malformed one, so a bad key is caught at boot rather than the first time somebody saves a secret. The tether is the exception: it relays encrypted settings to daemons without ever reading them, so it never holds the key. The CLI generates one for a new stack; a NixOS deployment sets `services.<service>.secretKeyFile`, and the allinone module creates one where the dashboard runs.

Upgrading an existing deployment means distributing the key before rolling out, since a host without one will not come back up.

A secret's value is never read back: the page shows that one is stored and a short fingerprint of it, and the audit trail records that it changed without recording what to. Replacing one means typing the new value in full.

Rotating the key means setting `XINITY_SECRET_KEY` to the new value and `XINITY_SECRET_KEY_PREVIOUS` to the old one, which is accepted for reading only. Values re-encrypt as they are next written.

### Settings that travel together

A few settings are only meaningful as a set, such as a web search provider and the credential it authenticates with, where what counts as a valid credential depends on which provider is chosen. These appear as one block with a single Save, are written in one transaction, and are judged together, so no component ever sees one half of a pair. Clearing one clears the whole set.
