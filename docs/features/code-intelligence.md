# Code Intelligence & AST Graph Memory

Xinity AI includes a multi-tenant, RBAC-protected Code Intelligence microservice (`xinity-code-intelligence`).

## Overview

Code Intelligence provides AI agents with instant, token-minimized structural knowledge of codebases without filling LLM context windows with raw source files.

### Key Capabilities

1. **Production AST Parsing**:
   - Uses official TypeScript Compiler API AST parsing (`ts.createSourceFile`) to extract classes, interfaces, top-level functions, and class methods.
   - Ignores string literals, comments, and non-code text.

2. **Cross-File Import Resolver**:
   - Resolves relative imports (`./`, `../`, `/index.ts`) across repository files to map module dependency edges (`imports`).

3. **SCIP Single-Line Compact Output (`format: "compact"`)**:
   - All symbol queries output token-minimized single lines (e.g. `[class] OrderController @ src/api.ts`).
   - Saves **70–80% of prompt tokens** compared to verbose JSON formatting.

4. **Multi-Tenancy & RBAC**:
   - Scoped strictly by `tenantId` and `repoId`.
   - Enforces JWT role claims (`graph:read`, `graph:write`, `graph:admin`, `repo:index`).

5. **Admin Opt-in Feature Toggle**:
   - Disabled by default (`CODE_INTELLIGENCE_ENABLED=false`). Administrator activation required.
