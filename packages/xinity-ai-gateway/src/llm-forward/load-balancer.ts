import { redis } from "bun";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "load-balancer" });

export type LoadBalanceStrategy = "random" | "round-robin" | "least-connections";

export type SelectHostInput = {
  hosts: string[];
  earlyHosts: string[];
  canaryProgress: number;
  hasEarlyModel: boolean;
  publicModel: string;
  prefixHashes?: string[];
};

export type SelectHostResult = {
  host: string;
  useFinalModel: boolean;
  /** Call when the request completes. Only meaningful for least-connections. */
  release: () => void;
};

const ROUND_ROBIN_PREFIX = "lb:rr:";
const CONN_PREFIX = "lb:conn:";
const PREFIX_KEY_PREFIX = "lb:prefix:";
const PREFIX_TTL = 300;
const AFFINITY_MARGIN = 2;

const CONN_SAFETY_TTL = 600;
const ROUND_ROBIN_TTL = 3600;

const connKey = (host: string) => `${CONN_PREFIX}${host}`;
const roundRobinKey = (resolvedModel: string) => `${ROUND_ROBIN_PREFIX}${resolvedModel}`;

const noOpRelease = (): void => {};

/** Atomically INCR a key and set its EXPIRE in one round-trip. */
const INCR_WITH_EXPIRE_SCRIPT = `
local v = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return v
`;

function incrWithExpire(key: string, ttl: number): Promise<boolean> {
  return redis.send("EVAL", [INCR_WITH_EXPIRE_SCRIPT, "1", key, String(ttl)])
    .then(() => true)
    .catch((err: unknown) => { log.warn({ err }, "Redis INCR+EXPIRE error"); return false; });
}

/** Atomically track a connection for least-connections balancing. Returns a release function. */
function trackConnection(host: string): { release: () => void } {
  const key = connKey(host);
  const incrPromise = incrWithExpire(key, CONN_SAFETY_TTL);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      incrPromise.then((ok) => {
        if (ok) redis.send("DECR", [key]).catch((err: unknown) => log.warn({ err }, "Redis DECR error"));
      });
    },
  };
}

async function lookupPrefixHint(hashes: string[], validHosts: string[]): Promise<string | null> {
  if (hashes.length === 0) {
    return null;
  }
  const keys = hashes.map(h => `${PREFIX_KEY_PREFIX}${h}`);
  const values = (await redis.send("MGET", keys)) as (string | null)[];
  for (const v of values) {
    if (v && validHosts.includes(v)) {
      return v;
    }
  }
  return null;
}

function storePrefixHint(hash: string, host: string): void {
  redis.send("SET", [`${PREFIX_KEY_PREFIX}${hash}`, host, "EX", String(PREFIX_TTL)])
    .catch((err: unknown) => log.warn({ err }, "Redis prefix store error"));
}

type HostSelection = { host: string; release: () => void };

function selectRandom(hosts: string[], hintHost: string | null): HostSelection {
  if (hintHost) {
    return { host: hintHost, release: noOpRelease };
  }
  return {
    host: hosts[Math.floor(Math.random() * hosts.length)]!,
    release: noOpRelease,
  };
}

async function withRandomFallback(
  hosts: string[],
  strategyLabel: string,
  body: () => Promise<HostSelection>,
): Promise<HostSelection> {
  try {
    return await body();
  } catch (err) {
    log.warn({ err }, `Redis error in ${strategyLabel}, falling back to random`);
    return selectRandom(hosts, null);
  }
}

function selectRoundRobin(hosts: string[], resolvedModel: string): Promise<HostSelection> {
  return withRandomFallback(hosts, "selectRoundRobin", async () => {
    const counter = await redis.send(
      "EVAL",
      [INCR_WITH_EXPIRE_SCRIPT, "1", roundRobinKey(resolvedModel), String(ROUND_ROBIN_TTL)],
    ) as number;
    const index = counter % hosts.length;
    return { host: hosts[index]!, release: noOpRelease };
  });
}

function selectLeastConnections(hosts: string[], hintHost: string | null): Promise<HostSelection> {
  return withRandomFallback(hosts, "selectLeastConnections", async () => {
    const keys = hosts.map(connKey);
    const counts = (await redis.send("MGET", keys)) as (string | null)[];

    let minCount = Infinity;
    let minIndex = 0;
    for (let i = 0; i < hosts.length; i++) {
      const count = parseInt(counts[i] ?? "0", 10) || 0;
      if (count < minCount) {
        minCount = count;
        minIndex = i;
      }
    }

    if (hintHost) {
      const hintIndex = hosts.indexOf(hintHost);
      if (hintIndex !== -1) {
        const hintCount = parseInt(counts[hintIndex] ?? "0", 10) || 0;
        if (hintCount <= minCount + AFFINITY_MARGIN) {
          const { release } = trackConnection(hintHost);
          return { host: hintHost, release };
        }
      }
    }

    const chosen = hosts[minIndex]!;
    const { release } = trackConnection(chosen);
    return { host: chosen, release };
  });
}

async function selectByStrategy(
  strategy: LoadBalanceStrategy,
  hosts: string[],
  resolvedModel: string,
  hintHost: string | null,
): Promise<{ host: string; release: () => void }> {
  const [single] = hosts;
  if (single && hosts.length === 1) {
    return { host: single, release: noOpRelease };
  }

  switch (strategy) {
    case "round-robin":
      return selectRoundRobin(hosts, resolvedModel);
    case "least-connections":
      return selectLeastConnections(hosts, hintHost);
    default:
      return selectRandom(hosts, hintHost);
  }
}

export async function selectHost(
  strategy: LoadBalanceStrategy,
  input: SelectHostInput,
): Promise<SelectHostResult | undefined> {
  const { hosts, earlyHosts, canaryProgress, hasEarlyModel, publicModel, prefixHashes } = input;

  const useFinalModel = !hasEarlyModel || Math.random() * 100 < canaryProgress;
  const targetHosts = useFinalModel ? hosts : earlyHosts;

  if (targetHosts.length === 0) {
    return undefined;
  }

  let hintHost: string | null = null;
  if (prefixHashes && prefixHashes.length > 0) {
    hintHost = await lookupPrefixHint(prefixHashes, targetHosts)
      .catch((err: unknown) => { log.warn({ err }, "Redis prefix lookup error"); return null; });
  }

  const resolvedModel = useFinalModel ? "final" : "early";
  const selected = await selectByStrategy(strategy, targetHosts, `${publicModel}:${resolvedModel}`, hintHost);

  if (prefixHashes && prefixHashes.length > 0) {
    storePrefixHint(prefixHashes[0]!, selected.host);
  }

  return {
    host: selected.host,
    useFinalModel,
    release: selected.release,
  };
}
