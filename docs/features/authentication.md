# Authentication & Authorization

For development setup and project structure, see the [dashboard README](../../packages/xinity-ai-dashboard/README.md). For instance-level SSO and user management, see [Instance Administration](instance-administration.md).

## Authentication Methods

The dashboard supports multiple authentication methods, all managed through [Better Auth](https://www.better-auth.com/):

### Email and password

The default method. Email verification is required when an SMTP server is configured (`MAIL_URL`). Signup can be restricted to invite-only via the `SIGNUP_ENABLED` environment variable. In invite-only mode, only users with a pending organization invitation can register.

Admin-created users receive a temporary password and are redirected to change it on first login.

### SSO (SAML and OIDC)

Enterprise single sign-on via SAML or OIDC identity providers. Providers can be configured at the instance level or per-organization (with the `sso` license feature). Users provisioned through SSO are assigned the `pending` role by default. See [Instance Administration](instance-administration.md) for provider management.

### Passkeys (WebAuthn/FIDO2)

Users can register hardware security keys or platform authenticators (Touch ID, Windows Hello) for passwordless login. Passkeys are managed in Settings > Authentication.

### Two-factor authentication (TOTP)

Users can enable time-based one-time passwords as a second factor for email/password sign-in. Setup is in Settings > Authentication and requires scanning a QR code with an authenticator app (Google Authenticator, Authy, 1Password, etc.). Ten single-use backup codes are generated at setup time for recovery.

When 2FA is enabled, the login flow prompts for a 6-digit code after entering credentials. Users can also authenticate with a backup code if the authenticator app is unavailable. Trusted device cookies are not currently configured.

2FA applies to email/password sign-in only. SSO and passkey logins bypass it.

### API keys

Two types of API keys serve different purposes:

| Key type | Scope | Used for |
|---|---|---|
| **AI API keys** | Gateway (inference) | Calling the OpenAI-compatible API, MCP server |
| **Dashboard API keys** | Dashboard REST API | Programmatic access to all dashboard operations |

Both are managed in the dashboard. AI API keys can be scoped to specific applications.

## Session Configuration

- Session expiration: 30 days.
- Automatic refresh: when the session is older than 1 day.
- Cookie cache: 5 minutes (reduces database lookups on rapid requests).

## RBAC (Role-Based Access Control)

Users are assigned a role per organization. Roles control access to six resource types: API keys, API calls, API call responses (labeling), model deployments, models, and applications.

| Role | Access | Notes |
|---|---|---|
| **owner** | Full access to all resources and organization settings | Can transfer ownership, delete the organization |
| **admin** | Full access to all resources, admin-level org settings | Cannot delete the organization |
| **member** | Full access to all resources, member-level org access | Cannot manage organization settings |
| **labeler** | Read calls, full labeling access, read models and applications | Designed for data annotators |
| **viewer** | Read-only access to calls, deployments, models, responses, applications | No write access |
| **pending** | No resource access | Placeholder for users awaiting role assignment |

The `member`, `labeler`, and `viewer` roles require the `all-roles` license feature. Without it, only `owner`, `admin`, and `pending` are available.

Permissions are enforced server-side via oRPC middleware and reflected client-side for UI gating.
