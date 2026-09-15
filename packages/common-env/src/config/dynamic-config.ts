import type { ConfigDef } from "./build";
import { splitDelegations, type RawEnv } from "./delegation";
import {
  configError,
  projectValues,
  resolveValues,
  type ConfigValues,
  type Provenance,
} from "./resolve";

export type ApplyOverrides = (overrides: Record<string, string>) => string[];

export type Teardown = () => Promise<void>;

export type ConfigFeed = (apply: ApplyOverrides) => Promise<Teardown>;

export type DynamicConfig<T> = {
  value: T;
  delegatedKeys: readonly string[];
  provenance: () => readonly Provenance[];
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

function valueAt(values: ConfigValues, path: readonly string[]): unknown {
  let cursor: unknown = values;
  for (const segment of path) {
    cursor = (cursor as ConfigValues | undefined)?.[segment];
  }
  return cursor;
}

export function createDynamicConfig<T>(deps: {
  declaration: ConfigDef<T>;
  rawEnv?: RawEnv;
  feed?: ConfigFeed;
}): DynamicConfig<T> {
  const { declaration } = deps;
  const { envWithFallbacks, delegatedKeys } = splitDelegations(
    declaration,
    deps.rawEnv ?? process.env,
  );
  const dynamicEntries = declaration.entries.filter((entry) => entry.isDynamic);

  const resolve = (env: RawEnv) => {
    const resolved = resolveValues(declaration, { env });
    if (resolved.problems.length > 0) {
      throw configError(resolved.problems);
    }
    return resolved;
  };

  let resolved = resolve(envWithFallbacks);
  let overriddenKeys = new Set<string>();
  let stopFeed: Teardown | null = null;

  const apply: ApplyOverrides = (overrides) => {
    const env: Record<string, string | undefined> = { ...envWithFallbacks };
    const applied = new Set<string>();
    for (const key of delegatedKeys) {
      const override = overrides[key];
      if (override !== undefined) {
        env[key] = override;
        applied.add(key);
      }
    }

    const next = resolve(env);
    const changed = dynamicEntries
      .filter((entry) => !Object.is(valueAt(resolved.values, entry.path), valueAt(next.values, entry.path)))
      .map((entry) => entry.path.join("."));

    resolved = next;
    overriddenKeys = applied;
    return changed;
  };

  return {
    value: projectValues<T>(declaration, () => resolved.values),
    delegatedKeys,

    provenance: () => resolved.provenance.map((entry) =>
      overriddenKeys.has(entry.envKey)
        ? { ...entry, source: "dynamic" as const }
        : entry),

    async start() {
      if (!deps.feed || stopFeed) {
        return;
      }
      stopFeed = await deps.feed(apply);
    },

    async stop() {
      const teardown = stopFeed;
      stopFeed = null;
      await teardown?.();
    },
  };
}
