import { RedisClient } from "bun";
import { config } from "./config";
import { rootLogger } from "./logger";

export const redis = new RedisClient(config.cache.url);

export async function checkRedis(): Promise<string | undefined> {
  const { protocol, host } = new URL(config.cache.url);
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
}
