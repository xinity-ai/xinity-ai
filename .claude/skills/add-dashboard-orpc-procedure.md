# Verify Procedure Permissions

When creating, modifying, or reviewing any oRPC procedure file in `packages/xinity-ai-dashboard/src/lib/server/orpc/procedures/`, verify that permission guards are correct.

## Middleware Pattern

Procedures that access org-scoped data MUST use this chain:

```typescript
rootOs
  .use(withOrganization)                         // Auth + org context
  .use(requirePermission({ resource: ["action"] }))  // RBAC check
  .route({ ... })
  .handler(async ({ context }) => { ... })
```

Available middleware (from `packages/xinity-ai-dashboard/src/lib/server/orpc/root.ts`):
- `withAuth`: Requires authenticated session only
- `withOrganization`: Requires auth + active organization context
- `requirePermission(spec)`: Must come after `withOrganization`, checks role-based permissions
- `withInstanceAdmin`: Requires auth + instance admin email

## Resources and Actions

Defined in `packages/xinity-ai-dashboard/src/lib/roles.ts`:

| Resource | Actions | DB Table |
|----------|---------|----------|
| apiKey | create, update, delete, read | `aiApiKeyT` |
| apiCall | read, delete | `apiCallT` |
| apiCallResponse | create, update, delete, read | `apiCallResponseT` |
| modelDeployment | create, update, delete, read | `modelDeploymentT` |
| model | create, update, delete, read | `trainedModelT` |
| aiApplication | create, update, delete, read | `aiApplicationT` |
| organization | create, read, update, delete | `organizationT` (from better-auth) |
| member | create, read, update, delete | `memberT` (from better-auth) |
| invitation | create, cancel | `invitationT` (from better-auth) |

## Role Grants

| Role | Permissions |
|------|-------------|
| owner | All actions on all resources |
| admin | All actions on all resources |
| member | All actions on all resources |
| labeler | apiCallResponse (CUD), apiCall (R), model (R), aiApplication (R) |
| viewer | apiCall (R), modelDeployment (R), model (R), apiCallResponse (R), aiApplication (R) |

## Decision Rules

For every new or modified procedure, determine which guard to use:

1. **Accesses/modifies org-scoped data** → `withOrganization` + `requirePermission({ resource: ["action"] })`
2. **Only accesses the user's own data** (e.g., user profile) → `withAuth` is sufficient
3. **Creates a new org context** (e.g., org creation) → `withAuth` + manual admin checks in handler
4. **Dev/internal only** → Add `NODE_ENV === "production"` guard in handler
5. **Unauthenticated entry point** → Document why explicitly in a comment
6. **Dual instance/org scope** (e.g., SSO) → Manual `auth.api.hasPermission()` check in handler for org-scoped, `isInstanceAdmin` for instance-wide

## Checklist

For every new or modified procedure:

- [ ] Does it access org-scoped data? If yes, uses `withOrganization`
- [ ] Does it read org data? Needs `requirePermission({ resource: ["read"] })`
- [ ] Does it create org data? Needs `requirePermission({ resource: ["create"] })`
- [ ] Does it update org data? Needs `requirePermission({ resource: ["update"] })`
- [ ] Does it delete org data? Needs `requirePermission({ resource: ["delete"] })`
- [ ] Is the resource in the access control statements in `roles.ts`? If not, add it
- [ ] Are role grants updated for any new resource/action?
- [ ] Is `permissions.svelte.ts` updated if UI visibility depends on the new resource?
- [ ] Does the handler filter queries by `context.activeOrganizationId` for org isolation?

## CLI Build Compatibility

The CLI (`packages/xinity-cli`) imports the dashboard's oRPC router at build time to extract routes. When a new procedure is added, **verify the CLI still builds**:

```bash
cd packages/xinity-cli && bun run build
```

### How it works

The CLI uses a stub plugin (`src/lib/dashboard-stubs.ts`) that intercepts problematic `$lib/server/*` imports. Any `$lib/server/*` module **not** in the stub map is loaded from its actual file, which is fine as long as the module has no side effects at import time.

Modules that **are safe to load directly** (not needing a stub):
- `$lib/server/info-client`: guarded by `building: true` from the `$app/environment` stub, so `createInfoserverClient()` is never called
- Any module whose only server deps are already stubbed (`serverenv`, `logging`, `auth-server`, etc.)

### When to add a new stub

Add to `serverStubs` in `packages/xinity-cli/src/lib/dashboard-stubs.ts` when a new server module:
- Opens a DB connection or runs a query at import time
- Calls `auth.api.*` or other network/IO at import time
- Imports a native binary or addon that's unavailable at build time

The `$app/environment` stub sets `building: true` and `browser: false`, so patterns like `export const x = building ? null : expensiveInit()` work without a stub.

### Checklist addition

- [ ] Run `cd packages/xinity-cli && bun run build`, bundle must succeed without errors

## Key Files

- Roles/AC: `packages/xinity-ai-dashboard/src/lib/roles.ts`
- Middleware: `packages/xinity-ai-dashboard/src/lib/server/orpc/root.ts`
- Procedures: `packages/xinity-ai-dashboard/src/lib/server/orpc/procedures/`
- Client permissions: `packages/xinity-ai-dashboard/src/lib/state/permissions.svelte.ts`
- Router: `packages/xinity-ai-dashboard/src/lib/server/orpc/router.ts`
- CLI stubs: `packages/xinity-cli/src/lib/dashboard-stubs.ts`
- CLI build: `packages/xinity-cli/build.ts`
