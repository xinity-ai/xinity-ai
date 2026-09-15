import type { ConfigDef } from "./build";
import { splitDelegations, type RawEnv } from "./delegation";
import { createDerivation, type Derivation, type Derived } from "./derivation";
import {
  configError,
  projectValues,
  resolveValues,
  sameConfigValue,
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
  derive: <I, R>(
    selectInputs: (value: T) => I,
    build: (inputs: I) => R,
    opts?: { dispose?: (value: R) => void },
  ) => Derived<R>;
  start: (feed: ConfigFeed) => Promise<void>;
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

  const value = projectValues<T>(declaration, () => resolved.values);
  const derivations = new Set<Derivation>();

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
      .filter((entry) => !sameConfigValue(valueAt(resolved.values, entry.path), valueAt(next.values, entry.path)))
      .map((entry) => entry.path.join("."));

    resolved = next;
    overriddenKeys = applied;

    for (const derivation of derivations) {
      derivation.revalidate();
    }
    return changed;
  };

  return {
    value,
    delegatedKeys,

    derive(selectInputs, build, opts) {
      const derivation = createDerivation({
        values: value,
        selectInputs,
        build,
        dispose: opts?.dispose,
      });
      derivations.add(derivation);
      return derivation;
    },

    provenance: () => resolved.provenance.map((entry) =>
      overriddenKeys.has(entry.envKey)
        ? { ...entry, source: "dynamic" as const }
        : entry),

    async start(feed) {
      if (stopFeed) {
        return;
      }
      stopFeed = await feed(apply);
    },

    async stop() {
      const teardown = stopFeed;
      stopFeed = null;
      await teardown?.();
    },
  };
}
