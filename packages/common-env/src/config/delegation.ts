import type { AnyConfig } from "./build";

export const DYNAMIC_SENTINEL = "@dynamic";

export type RawEnv = Readonly<Record<string, string | undefined>>;

export type Delegation = { readonly fallback?: string };

export function parseDelegation(raw: string | undefined): Delegation | null {
  if (raw === DYNAMIC_SENTINEL) {
    return {};
  }
  if (raw === undefined || !raw.startsWith(`${DYNAMIC_SENTINEL}:`)) {
    return null;
  }
  return { fallback: raw.slice(DYNAMIC_SENTINEL.length + 1) };
}

export type DelegationSplit = {
  readonly envWithFallbacks: Record<string, string | undefined>;
  readonly delegatedKeys: readonly string[];
};

function activationKeysOf(config: AnyConfig): Set<string> {
  return new Set(config.groups.flatMap((mounted) => mounted.activation));
}

export function splitDelegations(config: AnyConfig, env: RawEnv): DelegationSplit {
  const envWithFallbacks: Record<string, string | undefined> = { ...env };
  const delegatedKeys: string[] = [];
  const rejected: string[] = [];
  const activationKeys = activationKeysOf(config);

  for (const entry of config.entries) {
    const delegation = parseDelegation(env[entry.envKey]);
    if (!delegation) {
      continue;
    }

    if (!entry.isDynamic) {
      rejected.push(`${entry.envKey} is not declared dynamic`);
    } else if (activationKeys.has(entry.envKey)) {
      rejected.push(`${entry.envKey} decides whether its group is active, which cannot change while running`);
    }

    delegatedKeys.push(entry.envKey);
    envWithFallbacks[entry.envKey] = delegation.fallback;
    envWithFallbacks[`${entry.envKey}_FILE`] = undefined;
  }

  if (rejected.length > 0) {
    const capable = config.entries
      .filter((entry) => entry.isDynamic && !activationKeys.has(entry.envKey))
      .map((entry) => entry.envKey);
    throw new Error(
      `Invalid ${DYNAMIC_SENTINEL} delegation: ${rejected.join("; ")}. `
      + `Settings that accept it: ${capable.join(", ") || "(none)"}`,
    );
  }

  return { envWithFallbacks, delegatedKeys };
}
