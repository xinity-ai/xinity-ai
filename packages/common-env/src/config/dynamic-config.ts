import type { ConfigDef } from "./declaration";
import { readSecretFile, type SecretFileReader } from "../secret-file";
import { splitDelegations, type RawEnv } from "./delegation";
import { createDerivation, type Derivation, type Derived } from "./derivation";
import {
  configError,
  withDynamicAccessors,
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
  /** Runs `react` now and whenever the selected values change, for side effects rather than values. */
  watch: <I>(selectInputs: (value: T) => I, react: (inputs: I) => void) => () => void;
  start: (feed: ConfigFeed, opts?: { unseal?: Unseal }) => Promise<void>;
  stop: () => Promise<void>;
};

function valueAt(values: ConfigValues, path: readonly string[]): unknown {
  let cursor: unknown = values;
  for (const segment of path) {
    cursor = (cursor as ConfigValues | undefined)?.[segment];
  }
  return cursor;
}

export type Unseal = (envKey: string, value: string) => string | undefined;

export function createDynamicConfig<T>(deps: {
  declaration: ConfigDef<T>;
  rawEnv?: RawEnv;
}): DynamicConfig<T> {
  const { declaration } = deps;

  // Every override re-resolves the declaration, and a secret file must not be read again while serving.
  const secretFileContents = new Map<string, string>();
  const readSecretFileOnce: SecretFileReader = (path, envKey) => {
    let contents = secretFileContents.get(path);
    if (contents === undefined) {
      contents = readSecretFile(path, envKey);
      secretFileContents.set(path, contents);
    }
    return contents;
  };

  const { baseEnv, delegatedKeys } = splitDelegations(
    declaration,
    deps.rawEnv ?? process.env,
    readSecretFileOnce,
  );
  const dynamicEntries = declaration.entries.filter((entry) => entry.isDynamic);

  const resolve = (env: RawEnv) => {
    const resolved = resolveValues(declaration, { env, delegated: delegatedKeys, readSecretFile: readSecretFileOnce });
    if (resolved.problems.length > 0) {
      throw configError(resolved.problems);
    }
    return resolved;
  };

  let resolved = resolve(baseEnv);
  let overriddenKeys = new Set<string>();
  let stopFeed: Teardown | null = null;
  let unseal: Unseal | undefined;

  const value = withDynamicAccessors<T>(declaration, () => resolved.values);
  const derivations = new Set<Derivation>();

  const apply: ApplyOverrides = (overrides) => {
    const env: Record<string, string | undefined> = { ...baseEnv };
    const applied = new Set<string>();
    for (const key of delegatedKeys) {
      const override = overrides[key];
      if (override === undefined) {
        continue;
      }
      const opened = unseal ? unseal(key, override) : override;
      if (opened === undefined) {
        continue;
      }
      env[key] = opened;
      applied.add(key);
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

    watch(selectInputs, react) {
      const derivation = createDerivation({ values: value, selectInputs, build: (inputs) => inputs });
      derivations.add(derivation);
      return derivation.subscribe(react);
    },

    provenance: () => resolved.provenance.map((entry) =>
      overriddenKeys.has(entry.envKey)
        ? { ...entry, source: "dynamic" as const }
        : entry),

    async start(feed, opts) {
      if (stopFeed) {
        return;
      }
      unseal = opts?.unseal;
      stopFeed = await feed(apply);
    },

    async stop() {
      const teardown = stopFeed;
      stopFeed = null;
      await teardown?.();
    },
  };
}
