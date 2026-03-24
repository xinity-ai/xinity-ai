import { redis } from "bun";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "load-balancer" });

export type LoadBalanceStrategy = "random" | "round-robin" | "least-connections";

export type SelectHostInput = {
  /** Hosts serving the final (target) model */
  hosts: string[];
  /** Hosts serving the early (canary) model */
  earlyHosts: string[];
  /** Canary progress 0-100. 100 = all traffic to final model */
  canaryProgress: number;
  /** Whether an early model specifier exists */
  hasEarlyModel: boolean;
  /** API key ID, used for session affinity */
  keyId: string;
  /** Public model specifier, used for session affinity */
  publicModel: string;
};

export type SelectHostResult = {
  host: string;
  useFinalModel: boolean;
  /** Call when the request completes. Only meaningful for least-connections. */
  release: () => void;
};

const AFFINITY_PREFIX = "lb:affinity:";
const ROUND_ROBIN_PREFIX = "lb:rr:";
const CONN_PREFIX = "lb:conn:";

const AFFINITY_TTL = 300;
const CONN_SAFETY_TTL = 600;

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
  const connKey = `${CONN_PREFIX}${host}`;
  let shouldDecrement = false;
  incrWithExpire(connKey, CONN_SAFETY_TTL).then((ok) => { shouldDecrement = ok; });
  let released = false;
  return {
    release: () => {
      if (released || !shouldDecrement) return;
      released = true;
      redis.send("DECR", [connKey]).catch((err: unknown) => log.warn({ err }, "Redis DECR error"));
    },
  };
}

function selectRandom(hosts: string[]): { host: string; release: () => void } {
  return {
    host: hosts[Math.floor(Math.random() * hosts.length)]!,
    release: () => {},
  };
}

async function selectRoundRobin(
  hosts: string[],
  resolvedModel: string,
): Promise<{ host: string; release: () => void }> {
  try {
    const key = `${ROUND_ROBIN_PREFIX}${resolvedModel}`;
    const counter = await redis.send("INCR", [key]) as number;
    const index = counter % hosts.length;
    return {
      host: hosts[index]!,
      release: () => {},
    };
  } catch (err) {
    log.warn({ err }, "Redis error in selectRoundRobin, falling back to random");
    return selectRandom(hosts);
  }
}

async function selectLeastConnections(
  hosts: string[],
): Promise<{ host: string; release: () => void }> {
  try {
    const keys = hosts.map((h) => `${CONN_PREFIX}${h}`);
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

    const chosen = hosts[minIndex]!;
    const { release } = trackConnection(chosen);
    return { host: chosen, release };
  } catch (err) {
    log.warn({ err }, "Redis error in selectLeastConnections, falling back to random");
    return selectRandom(hosts);
  }
}

async function selectByStrategy(
  strategy: LoadBalanceStrategy,
  hosts: string[],
  resolvedModel: string,
): Promise<{ host: string; release: () => void }> {
  if (hosts.length === 1) {
    return { host: hosts[0]!, release: () => {} };
  }

  switch (strategy) {
    case "round-robin":
      return selectRoundRobin(hosts, resolvedModel);
    case "least-connections":
      return selectLeastConnections(hosts);
    default:
      return selectRandom(hosts);
  }
}

type AffinityRecord = { host: string; useFinalModel: boolean };

function affinityKey(keyId: string, publicModel: string): string {
  return `${AFFINITY_PREFIX}${keyId}:${publicModel}`;
}

async function getAffinity(keyId: string, publicModel: string): Promise<AffinityRecord | null> {
  try {
    const key = affinityKey(keyId, publicModel);
    const cached = await redis.send("GETEX", [key, "EX", String(AFFINITY_TTL)]) as string | null;
    if (!cached) return null;
    const parsed = JSON.parse(cached);
    if (typeof parsed?.host !== "string" || typeof parsed?.useFinalModel !== "boolean") {
      log.warn({ key }, "Malformed affinity record in cache, discarding");
      return null;
    }
    return parsed as AffinityRecord;
  } catch (err) {
    log.warn({ err }, "Redis error in getAffinity");
    return null;
  }
}

function setAffinity(keyId: string, publicModel: string, record: AffinityRecord): void {
  const key = affinityKey(keyId, publicModel);
  redis.send("SET", [key, JSON.stringify(record), "EX", String(AFFINITY_TTL)])
    .catch((err: unknown) => log.warn({ err }, "Redis error in setAffinity"));
}

export async function selectHost(
  strategy: LoadBalanceStrategy,
  input: SelectHostInput,
): Promise<SelectHostResult | undefined> {
  const { hosts, earlyHosts, canaryProgress, hasEarlyModel, keyId, publicModel } = input;

  // Step 1: Check session affinity
  const cached = await getAffinity(keyId, publicModel);
  if (cached) {
    const pool = cached.useFinalModel ? hosts : earlyHosts;
    if (pool.includes(cached.host)) {
      // Affinity hit, still need to track connection for least-connections
      const { release } = (strategy === "least-connections" && pool.length > 1)
        ? trackConnection(cached.host)
        : { release: () => {} };
      return { host: cached.host, useFinalModel: cached.useFinalModel, release };
    }
    // Cached host gone from pool, fall through to fresh selection
  }

  // Step 2: Canary decision
  const useFinalModel = !hasEarlyModel || Math.random() * 100 < canaryProgress;
  const targetHosts = useFinalModel ? hosts : earlyHosts;

  if (targetHosts.length === 0) {
    return undefined;
  }

  // Step 3: Select host via strategy
  const resolvedModel = useFinalModel ? "final" : "early";
  const selected = await selectByStrategy(strategy, targetHosts, `${publicModel}:${resolvedModel}`);

  // Step 4: Store affinity
  setAffinity(keyId, publicModel, { host: selected.host, useFinalModel });

  return {
    host: selected.host,
    useFinalModel,
    release: selected.release,
  };
}
