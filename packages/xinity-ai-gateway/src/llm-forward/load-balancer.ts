import { redis } from "bun";
import { rootLogger } from "../logger";
import {
  recordLbCandidateHosts,
  recordLbCanarySplit,
  recordLbSelection,
  recordLbPrefixAffinity,
  recordLbRedisFallback,
  incLbActiveConnections,
  decLbActiveConnections,
  type LbHostLabels,
} from "../metrics";

const log = rootLogger.child({ name: "load-balancer" });

export type LoadBalanceStrategy = "random" | "round-robin" | "least-connections";

/** Display metadata for a host, resolved from the ai_node table. */
export type HostMeta = { nodeId: string; machineName: string };

export type SelectHostInput = {
  hosts: string[];
  earlyHosts: string[];
  canaryProgress: number;
  hasEarlyModel: boolean;
  publicModel: string;
  prefixHashes?: string[];
  hostMeta?: Map<string, HostMeta>;
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

function hostLabels(host: string, hostMeta?: Map<string, HostMeta>): LbHostLabels {
  const meta = hostMeta?.get(host);
  return {
    host,
    node_id: meta?.nodeId ?? host,
    machine_name: meta?.machineName ?? host,
  };
}

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
function trackConnection(host: string, labels: LbHostLabels): { release: () => void } {
  const key = connKey(host);
  const incrPromise = incrWithExpire(key, CONN_SAFETY_TTL);
  incrPromise.then((ok) => { if (ok) incLbActiveConnections(labels); });
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      incrPromise.then((ok) => {
        if (ok) {
          redis.send("DECR", [key]).catch((err: unknown) => log.warn({ err }, "Redis DECR error"));
          decLbActiveConnections(labels);
        }
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

type SelectionReason =
  | "single_candidate"
  | "random"
  | "round_robin"
  | "least_connections"
  | "prefix_affinity_hit"
  | "redis_fallback";

type HostSelection = { host: string; release: () => void; reason: SelectionReason };

function selectRandom(hosts: string[], hintHost: string | null): HostSelection {
  if (hintHost) {
    return { host: hintHost, release: noOpRelease, reason: "prefix_affinity_hit" };
  }
  return {
    host: hosts[Math.floor(Math.random() * hosts.length)]!,
    release: noOpRelease,
    reason: "random",
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
    recordLbRedisFallback(strategyLabel);
    return { ...selectRandom(hosts, null), reason: "redis_fallback" };
  }
}

function selectRoundRobin(hosts: string[], resolvedModel: string): Promise<HostSelection> {
  return withRandomFallback(hosts, "round-robin", async () => {
    const counter = await redis.send(
      "EVAL",
      [INCR_WITH_EXPIRE_SCRIPT, "1", roundRobinKey(resolvedModel), String(ROUND_ROBIN_TTL)],
    ) as number;
    const index = counter % hosts.length;
    return { host: hosts[index]!, release: noOpRelease, reason: "round_robin" };
  });
}

function selectLeastConnections(
  hosts: string[],
  hintHost: string | null,
  hostMeta?: Map<string, HostMeta>,
): Promise<HostSelection> {
  return withRandomFallback(hosts, "least-connections", async () => {
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
          const { release } = trackConnection(hintHost, hostLabels(hintHost, hostMeta));
          return { host: hintHost, release, reason: "prefix_affinity_hit" };
        }
      }
    }

    const chosen = hosts[minIndex]!;
    const { release } = trackConnection(chosen, hostLabels(chosen, hostMeta));
    return { host: chosen, release, reason: "least_connections" };
  });
}

async function selectByStrategy(
  strategy: LoadBalanceStrategy,
  hosts: string[],
  resolvedModel: string,
  hintHost: string | null,
  hostMeta?: Map<string, HostMeta>,
): Promise<HostSelection> {
  const [single] = hosts;
  if (single && hosts.length === 1) {
    return { host: single, release: noOpRelease, reason: "single_candidate" };
  }

  switch (strategy) {
    case "round-robin":
      return selectRoundRobin(hosts, resolvedModel);
    case "least-connections":
      return selectLeastConnections(hosts, hintHost, hostMeta);
    default:
      return selectRandom(hosts, hintHost);
  }
}

export async function selectHost(
  strategy: LoadBalanceStrategy,
  input: SelectHostInput,
): Promise<SelectHostResult | undefined> {
  const { hosts, earlyHosts, canaryProgress, hasEarlyModel, publicModel, prefixHashes, hostMeta } = input;

  const useFinalModel = !hasEarlyModel || Math.random() * 100 < canaryProgress;
  const bucket = useFinalModel ? "final" : "early";
  const targetHosts = useFinalModel ? hosts : earlyHosts;

  recordLbCandidateHosts(publicModel, bucket, targetHosts.length);
  if (hasEarlyModel) {
    recordLbCanarySplit(publicModel, bucket);
  }

  if (targetHosts.length === 0) {
    return undefined;
  }

  let hintHost: string | null = null;
  let hintFound = false;
  if (prefixHashes && prefixHashes.length > 0) {
    hintHost = await lookupPrefixHint(prefixHashes, targetHosts)
      .catch((err: unknown) => { log.warn({ err }, "Redis prefix lookup error"); return null; });
    hintFound = hintHost !== null;
  }

  const selected = await selectByStrategy(strategy, targetHosts, `${publicModel}:${bucket}`, hintHost, hostMeta);

  if (prefixHashes && prefixHashes.length > 0) {
    storePrefixHint(prefixHashes[0]!, selected.host);
    recordLbPrefixAffinity(!hintFound ? "miss" : selected.reason === "prefix_affinity_hit" ? "hit" : "ignored");
  }

  recordLbSelection(hostLabels(selected.host, hostMeta), publicModel, bucket, strategy, selected.reason);

  return {
    host: selected.host,
    useFinalModel,
    release: selected.release,
  };
}
