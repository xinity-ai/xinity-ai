import { readSecretFile } from "../secret-file";
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

/** The sentinel form a deployment writes to hand a setting to the dashboard. */
export function delegate(fallback?: string): string {
  return fallback === undefined ? DYNAMIC_SENTINEL : `${DYNAMIC_SENTINEL}:${fallback}`;
}

/**
 * A secret's value normally lives in a file rather than the environment, so the marker that hands
 * it to the dashboard has to be looked for in both, or delegating one silently does nothing.
 */
function delegationOf(env: RawEnv, envKey: string): Delegation | null {
  const direct = parseDelegation(env[envKey]);
  if (direct) {
    return direct;
  }
  const path = env[`${envKey}_FILE`];
  if (path === undefined) {
    return null;
  }
  try {
    return parseDelegation(readSecretFile(path, envKey));
  } catch {
    // Unreadable is not this step's to report: resolution reaches the same file and names it.
    return null;
  }
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
    const delegation = delegationOf(env, entry.envKey);
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
