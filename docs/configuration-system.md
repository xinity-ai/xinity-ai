# Configuration system

Every service declares its configuration once, in code, with the helpers in `packages/common-env/src/config`. That one declaration is what parses the environment at startup, what the CLI prompts for, what the generated configuration tables in each package README list (`scripts/sync-config-docs.ts`), and what the dashboard can change while a service runs.

A value goes through four stages:

1. **Declare.** The service lists its settings as fields and groups.
2. **Resolve.** At startup the environment is read, optional groups are switched on or off, every value is parsed, and rules are checked. Any problem stops the service with a message naming the env keys involved.
3. **Expose.** The resolved values become the service's `config` object. A setting declared dynamic is exposed as a function, so code always reads its current value.
4. **Keep current.** For settings handed to the dashboard, overrides arrive while the service runs and are resolved again.

## Declaring

- `env("KEY", schema)` declares a field read from `KEY`. The schema is a zod schema, usually built from the helpers in `leaf-types.ts` (`configInt`, `configNumber`, `configBool`, `configList`), which parse the strings an environment holds.
- `dynamic("KEY", schema)` declares a field that may change while the service runs. Its value is read through a function (`config.cache.responseTtlSeconds()`), so every read site is visibly one that can see a new value.
- `defineGroup({ id, title, fields })` gathers related fields. A group with `optional: { requires: [...] }` is only active when all of the listed fields are set. A group can declare `violations`, rules over its parsed values.
- `defineConfig({ ... })` mounts fields and groups into the service declaration. It can declare `violations` across groups.
- Markers on a schema add metadata: `.describe()` for the description, `.meta(secret())` for values that must not be shown or logged, `.meta(expert())` for advanced settings, and `.meta(clientPublic())` for values the dashboard passes to the browser.
- `shared-groups.ts` holds the groups several services mount (HTTP server, database, TLS, object storage, metrics, reverse proxy).

## Resolving

`resolveValues` in `resolve.ts` runs these steps:

1. **Find raw values.** For each field, `KEY` is used when it is set and not empty. Otherwise `KEY_FILE` names a file holding the value. An empty value counts as unset, so a Compose `${VAR:-}` behaves like a missing variable.
2. **Decide activation.** An optional group is active when all of its required fields are set, and inactive when none are. A group with only some of them set stays inactive and produces a warning. A partly configured TLS group stops the service instead, so it never serves plaintext when asked for HTTPS.
3. **Parse each member.** A field is parsed with its schema. An active group is parsed as one object. A `KEY_FILE` is only read here, so the file behind a setting in an inactive group is never opened.
4. **Check rules.** Group rules run once their group has parsed. Config-wide rules run only when everything else parsed, since they read values a failed member would have left out. A rule that involves a setting handed to the dashboard is skipped, because that setting has no value of its own yet.

Each failure becomes a problem naming the env keys and pointers (`cache.responseTtlSeconds`) it concerns. `resolveConfig` turns any problems into one error listing all of them.

`withDynamicAccessors` then builds the object a service reads: plain values for static fields, and functions returning the current value for dynamic ones.

## Handing settings to the dashboard

Writing `KEY=@dynamic`, or `KEY=@dynamic:<fallback>`, hands a dynamic setting to the dashboard. The marker may also be the content of `KEY_FILE`, which is how a secret is handed over. Only fields declared with `dynamic(...)` accept it, and not the fields that decide whether a group is active, since activation cannot change while a service runs. The service uses the fallback (or the declared default) until the dashboard supplies a value.

`createDynamicConfig` in `dynamic-config.ts` holds a service's configuration while it runs:

- It splits out the handed-over settings (`splitDelegations`), giving a base environment in which each of them holds its fallback, and resolves that once at startup.
- Secret files are read once, at startup, and reused for every later resolve.
- A feed delivers the dashboard's overrides. The dashboard, gateway and tether read them from the `dynamic_config` table and are notified of changes on a Postgres `NOTIFY` channel (`createDbConfigFeed`). The feed coalesces bursts of notifications, retries failed reads with backoff, and re-reads every four hours in case a notification was lost. The daemon has no database connection and receives the same overrides as events on its tether stream.
- Applying overrides layers them onto the base environment, opens values that are stored encrypted (the unsealer), resolves again, and reports the pointers whose values changed. When the new values do not resolve, the previous ones stay in place.
- `derive(select, build)` keeps a value built from configuration (a client, a pool) and rebuilds it when the settings it was built from change. `watch(select, react)` runs a side effect on each such change.
- `provenance()` reports where each value came from: `env`, `env-file`, `default`, or `dynamic` for a value the dashboard supplied.

## Other uses of a declaration

- `analyzeConfig` flattens a declaration into one row per env key, with its description, default, and markers. The CLI builds its configuration menus from it, and `scripts/sync-config-docs.ts` generates the README tables from it.
- `checkConfig` returns the problems without throwing. The CLI uses it to validate a configuration while it is being edited.

## Terms

| Term | Meaning |
|---|---|
| Field | One setting, read from one env key. |
| Group | Related fields parsed together, optionally only active when its required fields are set. |
| Member | A field or a group mounted at the top level of a declaration. |
| Entry | The flattened record of one field: env key, path, schema, and markers. |
| Pointer | An entry's path joined with dots, such as `cache.responseTtlSeconds`. |
| Activation | Whether an optional group is on, decided by which of its required fields are set. |
| Delegation | Handing a dynamic setting to the dashboard with the `@dynamic` marker. |
| Override | A value the dashboard supplies for a delegated setting. |
| Provenance | Where a resolved value came from. |
