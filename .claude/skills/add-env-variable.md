# Add Environment Variable

When adding a new environment variable to any service package, follow this pattern.

## Env schema separation

Each service package has two env files:
- **`env-schema.ts`**: exports a Zod object schema with `.describe()` and `.meta(secret())` annotations. No side effects, safe to import from CLI or tests.
- **`env.ts`** (or `serverenv.ts` for dashboard): imports the schema and calls `parseEnv()` which reads `process.env`.

| Package | Schema file | Runtime file |
|---------|------------|-------------|
| gateway | `src/env-schema.ts` -> `gatewayEnvSchema` | `src/env.ts` |
| daemon | `src/env-schema.ts` -> `daemonEnvSchema` | `src/env.ts` |
| dashboard | `src/lib/server/env-schema.ts` -> `dashboardEnvSchema` | `src/lib/server/serverenv.ts` |

## Steps

1. **Add to the schema file** with `.describe("Human-readable description")`.
2. **Mark secrets** with `.meta(secret())` (imported from `common-env`). The CLI reads `z.globalRegistry.get(field)?.secret` to decide what goes into systemd `LoadCredential` secret files vs. plain `EnvironmentFile` entries.
3. **The runtime file does not need changes** - it parses from the schema automatically.
4. **Update `example.env`** if this variable should have a default for local dev.

## Example

```typescript
// In env-schema.ts
import { secret } from "common-env";

export const gatewayEnvSchema = z.object({
  // ... existing vars
  MY_NEW_VAR: z.string().describe("What this var controls"),
  MY_SECRET_VAR: z.string().describe("A secret value").meta(secret()),
});
```
