# common-env

Shared runtime infrastructure for Xinity services. Despite the name, this package goes beyond environment variables: it provides the foundational utilities that every service in the monorepo builds on for configuration, authentication, and inter-service protocol definitions.

## What's in here

### Environment parsing (`parseEnv`)

Every Xinity service defines a Zod schema for its configuration and passes it to `parseEnv`. This gives you:

- **`KEY_FILE` secret indirection.** For any schema key `FOO`, setting `FOO_FILE=/path/to/secret` reads the file at startup. This is how secrets flow through systemd `LoadCredential` and Docker secrets without touching env vars directly.
- **Empty-string normalization.** Docker Compose's `${VAR:-}` interpolation produces empty strings rather than unset vars. `parseEnv` treats them as `undefined` so Zod defaults and `.optional()` work correctly.
- **Zod validation.** Type coercion, URL validation, enum constraints are all expressed in the schema and enforced at startup.

### Schema metadata markers

Zod `.meta()` annotations that the CLI and dashboard use to classify env vars:

| Marker | Purpose |
|---|---|
| `secret()` | Value is sensitive. The CLI writes it into a systemd `LoadCredential` file instead of a plain `EnvironmentFile`. |
| `expert()` | Advanced tuning knob. The CLI and dashboard separate these from essential fields during setup. |
| `clientPublic()` | Safe to forward to the browser via SvelteKit layout data. |

### Metrics authentication

A complete HTTP Basic-auth subsystem for Prometheus `/metrics` endpoints:

- `metricsAuthSchema()` validates the `user:pass[,user:pass,...]` config format.
- `createMetricsAuth(raw)` returns a guard object with `isAuthorized(header)` and `unauthorized(header)` methods.
- All credential comparisons use constant-time SHA-256 digests via `timingSafeEqual`.

### Tether protocol schemas

Zod schemas and TypeScript types defining the wire contract between the tether and daemon nodes. Shared here so both sides validate against the same definitions:

- **Outbound** (tether to daemon, SSE): `DesiredState` containing installation assignments.
- **Inbound** (daemon to tether, POST): `NodeRegistration` for hardware enrollment, `InstallationStateReport` for lifecycle updates.

### TLS helpers

`tlsEnvSchema` provides reusable cert/key fields. `getTlsConfig(env)` returns a `{ cert, key }` pair or `undefined`, and throws on partial configuration (cert without key or vice versa).

### Shell escaping

`quoteShellArg` and `quoteShellArgv` for POSIX-safe single-quote escaping when constructing shell commands.
