---
name: add-env-variable
description: Add a new configuration variable to any service package, declaring it on the package's grouped config declaration with an explicit env key, describe(), and meta(secret()) annotations.
---

# Add Configuration Variable

Every service declares its configuration as named groups of fields. A variable is a field on one
of those groups, bound to an env key that stays greppable.

## Where it goes

| Package | Declaration | Resolved value |
|---------|------------|----------------|
| gateway | `src/config-schema.ts` -> `gatewayConfig` | `src/config.ts` -> `config` |
| tether | `src/config-schema.ts` -> `tetherConfig` | `src/config.ts` |
| daemon | `src/config-schema.ts` -> `daemonConfig` | `src/config.ts` |
| infoserver | `config-schema.ts` -> `infoserverConfig` | `config.ts` |
| dashboard | `src/lib/server/config-schema.ts` -> `dashboardConfig` | `src/lib/server/config.ts` |

## Steps

1. **Pick the group** the variable belongs to, or add it top-level when it belongs to none.
   Shared groups (`serverGroup`, `databaseGroup`, `catalogGroup`, `metricsGroup`,
   `objectStorageGroup`, `tlsGroup`, `proxyGroup`, `loggingGroup`) already declare their own keys.
2. **Add the field to the group's hand-written type first.** `defineGroup<T>` validates that the
   field keys match `keyof T` and that each schema produces `T[K]`, so the type is the contract
   and nothing is inferred.
3. **Declare the field** as `env("MY_NEW_VAR", schema)`. Both names appear in the source so the
   env key greps and the field jumps to its definition.
4. **Use a dual leaf for non-strings**: `configBool()`, `configInt()`, `configNumber()`,
   `configList()`. Constraints go on their `base` argument, as in `configInt(z.int().positive())`.
5. **Mark secrets** with `.meta(secret())`. The CLI reads that to decide what goes into systemd
   `LoadCredential` secret files rather than plain `EnvironmentFile` entries.
6. **Update `example.env`** if the variable wants a value for local dev.

Reading it is `config.group.field`. Nothing else needs changing: the CLI builds its editor from
the declaration, and the resolved value is typed from it.

## Example

```typescript
type WebSearch = { provider?: "searxng" | "google"; credential?: string };

const webSearch = defineGroup<WebSearch>({
  id: "webSearch",
  title: "Web search",
  expert: true,
  fields: {
    provider: env("WEB_SEARCH_PROVIDER", z.enum(["searxng", "google"]).optional()
      .describe("Web search backend. When unset, web search is disabled.")),
    credential: env("WEB_SEARCH_CREDENTIAL", z.string().optional()
      .describe("Provider credential").meta(secret())),
  },
});
```

## Groups that switch on and off

A group whose members are meaningless on their own takes `optional: { requires: [...] }`, naming
the fields whose presence activates it. It resolves to `undefined` when none are set, and warns at
boot when only some are. Every member has to be meaningless without those keys, so an optional
field inside an optional group is a sign the grouping is wrong.

## Rules that span fields

`violations: (value) => [{ field, message }]` rejects combinations no single field can catch, such
as a keepalive longer than the idle timeout it has to fit inside. The CLI runs the same check
before it writes, so its editor cannot save a combination the service would refuse.
