# Xinity Code Intelligence & Graph Memory (`xinity-code-intelligence`)

`xinity-code-intelligence` is an enterprise-grade, multi-tenant, RBAC-protected Code Intelligence and Graph Memory package for Xinity AI built on top of TypeScript Compiler API AST parsing and the Model Context Protocol (MCP).

## Key Features

- **Multi-Tenancy & Isolation**: Isolated graph storage scoped strictly by `tenantId` and `repoId`.
- **RBAC Governance**: Fine-grained access control (`graph:read`, `graph:write`, `graph:admin`, `repo:index`) enforced on every query via JWT token claims.
- **Production AST Parsing**: Powered by the official TypeScript Compiler API (`ts.createSourceFile`) to parse real classes, methods, functions, and interfaces while ignoring comments and strings.
- **Cross-File Import Resolver**: Resolves relative module specifiers (`./`, `../`, `/index.ts`) to construct `imports` relation edges between workspace files.
- **Token Minimization (`format: "compact"`)**: SCIP-style single-line text output (e.g. `[class] OrderController @ src/api.ts`) saving **70–80% of prompt tokens** compared to verbose JSON.
- **Admin Feature Toggle**: Disabled by default (`CODE_INTELLIGENCE_ENABLED=false`). Requires explicit administrator activation.

---

## Directory Architecture Overview

```
packages/xinity-code-intelligence/
├── src/
│   ├── audit/
│   │   └── logger.ts          # Structured audit logger for compliance
│   ├── auth/
│   │   └── rbac.ts            # RBAC engine, JWT token verification & permissions
│   ├── config/
│   │   └── index.ts           # Package configuration & feature toggles
│   ├── db/
│   │   └── graphStorage.ts    # Multi-tenant graph database layer
│   ├── indexing/
│   │   └── indexer.ts         # Async AST repository parser & import resolver
│   ├── mcp/
│   │   └── server.ts          # Enterprise MCP server definition & tools
│   ├── index.ts               # Package entrypoint
│   └── index.test.ts          # Unit test suite
├── package.json
├── tsconfig.json
└── README.md
```

---

## MCP Tools Reference

Every tool requires a valid JWT `authToken` argument and supports an optional `format` parameter (`compact` | `json`).

| Tool Name | Required Permission | Description |
|---|---|---|
| `enterprise_query_symbols` | `graph:read` | Searches symbol names (classes, functions, files) with token-minimized output (`format: compact`). |
| `enterprise_get_neighbors` | `graph:read` | Returns connected nodes and edges (defines, imports, contains) for a specific graph symbol. |
| `enterprise_tenant_overview` | `graph:read` | Retrieves graph metrics (total symbols, relations by type) for a tenant. |
| `enterprise_index_repository` | `repo:index` | Triggers background AST parsing & indexing of a codebase directory path. |

---

## Integration with Fine-Tuning Pipeline

When `includeCodeIntelligence` is enabled during fine-tuning dataset export, `xinity-fine-tuning` queries `MultiTenantGraphStorage` to inject indexed AST graph symbols into training ChatML system prompts:

```typescript
import { FineTuningExporter } from 'xinity-fine-tuning';

const dataset = FineTuningExporter.exportChatML(apiCalls, {
  includeCodeIntelligence: true,
  graphSymbolsContext: "[class] UserService @ src/service.ts"
});
```

---

## License & Governance

Part of the Xinity AI sovereign enterprise platform.
