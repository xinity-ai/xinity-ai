import { RedisClient } from "bun";
import { config } from "./config";
import { rootLogger } from "./logger";

export type Cache = {
  check(): Promise<string | undefined>;
  get(key: string): Promise<string | null>;
  mget(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  delPrefix(prefix: string): Promise<void>;
  incr(key: string, ttlSeconds: number): Promise<number>;
  tryIncr(key: string, limit: number, ttlSeconds: number): Promise<boolean>;
  decr(key: string): Promise<void>;
};

const INCR_WITH_EXPIRE_SCRIPT = `
local v = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return v
`;
const TRY_INCR_SCRIPT = `
local v = redis.call('INCR', KEYS[1])
if v > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;
const SCAN_BATCH = 200;

export function redisCache(url: string): Cache {
  const redis = new RedisClient(url);
  return {
    async check() {
      const { protocol, host } = new URL(url);
      const target = `${protocol}//${host}`;
      try {
        // connect() reports every failure as a closed connection. Only a command surfaces WRONGPASS.
        await redis.send("PING", []);
        rootLogger.info({ target }, "Cache connected");
        return undefined;
      } catch (err) {
        const { code, message } = err as Error & { code?: string };
        return code === "ERR_REDIS_AUTHENTICATION_FAILED"
          ? `Redis at ${target} rejected the credential in REDIS_URL: ${message}`
          : `Redis at ${target} is unreachable: ${message}`;
      }
    },
    get: (key) => redis.get(key),
    mget: async (keys) => (await redis.send("MGET", keys)) as (string | null)[],
    async set(key, value, ttlSeconds) {
      await redis.set(key, value, "EX", ttlSeconds);
    },
    async del(key) {
      await redis.del(key);
    },
    async delPrefix(prefix) {
      let cursor = "0";
      do {
        const [next, keys] = await redis.send("SCAN", [
          cursor, "MATCH", `${prefix}*`, "COUNT", String(SCAN_BATCH),
        ]) as [string, string[]];
        if (keys.length > 0) {
          await redis.send("DEL", keys);
        }
        cursor = next;
      } while (cursor !== "0");
    },
    incr: async (key, ttlSeconds) =>
      (await redis.send("EVAL", [INCR_WITH_EXPIRE_SCRIPT, "1", key, String(ttlSeconds)])) as number,
    tryIncr: async (key, limit, ttlSeconds) =>
      (await redis.send("EVAL", [TRY_INCR_SCRIPT, "1", key, String(limit), String(ttlSeconds)])) === 1,
    async decr(key) {
      await redis.send("DECR", [key]);
    },
  };
}

const SWEEP_INTERVAL_MS = 60_000;

export function memoryCache(): Cache {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  const read = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  const write = (key: string, value: string, ttlSeconds: number) => {
    entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  };

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) {
        entries.delete(key);
      }
    }
  }, SWEEP_INTERVAL_MS).unref();

  return {
    check: async () => undefined,
    get: async (key) => read(key)?.value ?? null,
    mget: async (keys) => keys.map((key) => read(key)?.value ?? null),
    set: async (key, value, ttlSeconds) => write(key, value, ttlSeconds),
    del: async (key) => {
      entries.delete(key);
    },
    delPrefix: async (prefix) => {
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) {
          entries.delete(key);
        }
      }
    },
    incr: async (key, ttlSeconds) => {
      const next = Number(read(key)?.value ?? 0) + 1;
      write(key, String(next), ttlSeconds);
      return next;
    },
    tryIncr: async (key, limit, ttlSeconds) => {
      const current = Number(read(key)?.value ?? 0);
      if (current >= limit) {
        return false;
      }
      write(key, String(current + 1), ttlSeconds);
      return true;
    },
    decr: async (key) => {
      const entry = read(key);
      if (entry) {
        entry.value = String(Number(entry.value) - 1);
      }
    },
  };
}

export const cache: Cache = config.cache.url ? redisCache(config.cache.url) : memoryCache();
