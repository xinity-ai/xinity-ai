# Dashboard Test Plan

Tests for xinity-ai-dashboard using `bun test`.

---

## Testing Philosophy

- **Integration over unit**: Test behaviors, not implementations
- **One test, many assertions**: Group related checks to minimize setup/teardown
- **Mock at boundaries**: Mock external services (auth), not internal functions
- **Real database sparingly**: Use in-memory or test DB only for critical flows

---

## 1. Permission System

### 1.1 Role Permission Matrix (Pure Logic - No DB)

A single test file that validates all roles have the correct permissions by calling `organization.checkRolePermission` directly. No database needed.

```
roles.test.ts
├── owner has full CRUD on all resources
├── admin has full CRUD on all resources
├── member has full CRUD on all resources
├── labeler has limited permissions (read apiCall/model/aiApplication, CUD apiCallResponse)
└── viewer has read-only (apiCall, modelDeployment, model, aiApplication)
```

### 1.2 Permission State Module (Unit - No DB)

Test the `permissions` module logic with mocked auth client.

```
permissions.test.ts
├── setRole updates state and sets loading false
├── can() returns false when role is null
└── can() delegates to organization.checkRolePermission correctly
```

---

## 2. oRPC Procedures

### 2.1 Permission Middleware Integration

One test per resource type that verifies the permission middleware works. Use a mocked `auth.api.hasPermission` to avoid DB calls.

```
orpc-permissions.test.ts
├── application endpoints enforce correct permissions (create/read/update/delete)
├── apiKey endpoints enforce correct permissions
├── deployment endpoints enforce correct permissions
└── apiCall endpoints enforce correct permissions
```

### 2.2 Procedure Logic (With Test DB - Sparingly)

Only test business logic that can't be verified otherwise. These require a test database.

```
orpc-procedures.test.ts
├── application.create inserts and returns application
├── application.list excludes soft-deleted and other orgs
├── apiKey.create generates valid key format (sk_xxx)
└── deployment operations trigger syncDeployedModels
```

---

## 3. UI Permission Gating

### 3.1 Sidebar Visibility (Component - Mocked Permissions)

Single test that renders Sidebar with different permission states.

```
sidebar.test.ts
├── with viewer permissions: only shows Home, Organizations, Settings, Logout
├── with owner permissions: shows all navigation items
└── with partial permissions: shows only permitted items
```

### 3.2 API Keys Page (Component - Mocked Permissions)

```
api-keys-page.test.ts
├── viewer sees read-only UI (no create/edit/delete buttons)
├── owner sees full UI with all action buttons
└── ApplicationManager hidden when canViewApplications is false
```

---

## 4. Error Handling

### 4.1 Error Handler Utils (Pure Logic - No DB)

```
error-handler.test.ts
├── extracts error codes from various error shapes
├── returns user-friendly messages for known error codes
└── isPermissionError identifies FORBIDDEN/UNAUTHORIZED
```

---

## 5. MCP Endpoint

### 5.1 Tool Visibility (API - No Mocking)

Verify that `tools/list` returns only procedures that are not excluded via `meta({ mcp: false })`. Uses a direct HTTP POST to `/mcp` with JSON-RPC.

```
e2e/api/mcp.test.ts (tool visibility)
├── tools/list does not contain any excluded procedure names
│   (account_changePassword, account_listPasskeys, account_deletePasskey,
│    account_listDashboardApiKeys, account_createDashboardApiKey, account_deleteDashboardApiKey,
│    sso_registerOidc, sso_registerSaml, sso_deleteProvider,
│    organization_deleteOrganization, onboarding_setupOnboarding, onboarding_cli,
│    instanceAdmin_listUsers, instanceAdmin_banUser, instanceAdmin_unbanUser,
│    instanceAdmin_addUserToOrganization, instanceAdmin_removeUserFromOrganization,
│    instanceAdmin_updateUserRole, instanceAdmin_listOrganizations,
│    instanceAdmin_getOrganizationMembers, instanceAdmin_setSsoSelfManage,
│    apiCall_addExampleCalls)
├── tools/list contains expected included tools (e.g. apiKey_list, deployment_list)
└── tools/call with an excluded tool name returns "Unknown tool" error
```

### 5.2 Permission Enforcement via MCP (API - Requires Setup)

Verify that the oRPC permission middleware runs correctly when tools are called through the MCP endpoint. Requires dashboard API keys for both owner and viewer roles.

The owner API key is already created by global-setup. A viewer dashboard API key needs to be created in `beforeAll` via the auth API using viewer session cookies.

```
e2e/api/mcp.test.ts (permissions)
├── owner can call apiKey_list via MCP (returns tool result)
├── viewer cannot call apiKey_create via MCP (returns permission error in tool result)
└── request without API key returns JSON-RPC error -32001 (Unauthorized)
```

---

## 6. E2E Smoke Tests (With Real App)

Minimal set of critical paths using Playwright or similar.

```
e2e/
├── auth-flow.test.ts - login redirects work
├── viewer-permissions.test.ts - viewer cannot access create actions
└── owner-crud.test.ts - owner can create/edit/delete resources
```

---

## Test Count Summary

| Category | Tests | DB Required |
|----------|-------|-------------|
| Role Permissions | 5 | No |
| Permission State | 3 | No |
| oRPC Permission Middleware | 4 | No (mocked) |
| oRPC Business Logic | 4 | Yes |
| MCP Tool Visibility | 3 | Yes |
| MCP Permission Enforcement | 3 | Yes |
| UI Sidebar | 3 | No |
| UI API Keys Page | 3 | No |
| Error Handling | 3 | No |
| E2E Smoke | 3 | Yes |
| **Total** | **34** | **13 with DB** |

---

## Setup Notes

### Mocking Auth for Procedure Tests

```typescript
import { mock } from "bun:test";

// Mock hasPermission to control access
mock.module("$lib/server/auth-server", () => ({
  auth: {
    api: {
      hasPermission: async ({ body }) => {
        // Return based on test scenario
        return { success: testUserHasPermission(body.permissions) };
      },
      getSession: async () => mockSession,
    },
  },
}));
```

### Mocking Permissions for Component Tests

```typescript
mock.module("$lib/state/permissions.svelte", () => ({
  permissions: {
    role: "viewer",
    can: (r, a) => r === "apiCall" && a === "read",
    canViewApiKeys: false,
    canViewData: true,
    // ...
  },
}));
```

---

## Priority Order

1. **Role Permissions** - Ensures role definitions are correct
2. **oRPC Permission Middleware** - Ensures API is protected
3. **MCP Endpoint** - Ensures excluded tools are hidden and permissions enforced via MCP
4. **UI Permission Gating** - Ensures users see correct UI
5. **E2E Smoke Tests** - Ensures critical paths work end-to-end
