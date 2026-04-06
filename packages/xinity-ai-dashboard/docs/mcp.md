# MCP Server - Developer Guide

The dashboard exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/mcp` that lets AI assistants call management operations via natural language. This document covers how it works and how to extend it.

## How tools are generated

`src/lib/server/mcp.ts` exports a `buildToolList()` function that recursively walks the oRPC router at module load time. Every procedure in the router becomes an MCP tool unless explicitly excluded. The tool list is built once and reused for all requests.

Each tool gets:
- **name**: the procedure's path segments joined with underscores (e.g. `apiKey_create`)
- **description**: from the procedure's `.route({ summary })` or `.route({ description })`, falling back to the path
- **inputSchema**: the procedure's Zod input schema converted to JSON Schema via `toJSONSchema()`

Because the tool list is derived automatically, adding a new oRPC procedure makes it available via MCP with no extra work.

## Excluding a procedure from MCP

Chain `.meta({ mcp: false })` on the procedure definition:

```typescript
export const myProcedure = withOrganization
  .meta({ mcp: false })
  .route({ method: "POST", path: "/my-thing", summary: "Do something" })
  .input(z.object({ ... }))
  .handler(async ({ input, context }) => {
    // ...
  });
```

The `ProcedureMeta` type is defined in `src/lib/server/orpc/root.ts`:

```typescript
export type ProcedureMeta = {
  /** Set to `false` to exclude this procedure from the MCP server endpoint. Defaults to included. */
  mcp?: boolean;
};
```

### When to exclude

Exclude procedures that:
- **Manage credentials** (passwords, passkeys, dashboard API keys) - these should only be changed through the UI or regular api with proper session context
- **Are destructive and irreversible** (e.g. organization deletion)
- **Require multi-step UI flows** (onboarding, SSO provider setup)
- **Are dev-only** (e.g. adding example data)
- **Require instance admin privileges** - these operate outside the normal org-scoped RBAC model

## Authentication

The endpoint at `src/routes/mcp/+server.ts` accepts API keys via two headers (checked in order):

1. `Authorization: Bearer sk_...`
2. `x-api-key: sk_...`

When a tool is called, `callMcpTool()` creates a synthetic `Request` with the API key in the `x-api-key` header and passes it through the full oRPC middleware chain (`withAuth` -> `withOrganization` -> `requirePermission`). This means MCP tool calls go through the same authentication and RBAC enforcement as regular API requests.

The `withOrganization` middleware resolves the organization from the API key's metadata, since MCP sessions don't have an active organization set in the browser session.

## Schema mapping

Zod schemas are converted to JSON Schema using the `toJSONSchema()` function from the `zod` package. One notable override:

- `z.date()` is mapped to `{ type: "string", format: "date-time" }` so MCP clients know to pass ISO 8601 strings (e.g. `"2025-01-15T00:00:00Z"`) rather than getting an opaque `{}` schema.

If a procedure has no input schema, it defaults to `{ type: "object", properties: {} }`.

## Disabling the endpoint

Set `MCP_ENABLED=false` in the environment. The variable is defined in `src/lib/server/env-schema.ts` and defaults to `true`. When disabled, the `/mcp` endpoint returns 404.

## Key files

| File | Role |
|------|------|
| `src/lib/server/mcp.ts` | Tool registry (`buildToolList`) and execution (`callMcpTool`) |
| `src/routes/mcp/+server.ts` | HTTP endpoint, JSON-RPC message handling, authentication |
| `src/lib/server/orpc/root.ts` | `ProcedureMeta` type, shared middleware chain |
| `src/lib/server/env-schema.ts` | `MCP_ENABLED` environment variable definition |
