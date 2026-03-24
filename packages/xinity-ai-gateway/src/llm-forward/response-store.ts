import { redis } from "bun";
import { env } from "../env";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "response-store" });

const responseKey = (id: string) => `response:${id}`;

export async function saveResponse(id: string, payload: unknown): Promise<void> {
  await redis.set(
    responseKey(id),
    JSON.stringify(payload),
    "EX",
    env.RESPONSE_CACHE_TTL_SECONDS
  );
}

export async function getResponse(id: string): Promise<unknown | null> {
  let payload: string | null;
  try {
    payload = await redis.getex(
      responseKey(id),
      "EX",
      env.RESPONSE_CACHE_TTL_SECONDS
    );
  } catch (err) {
    log.warn({ err }, "Redis error in getResponse");
    return null;
  }
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch (err) {
    log.error({ err, responseId: id }, "Corrupted response data in Redis");
    return null;
  }
}

export async function deleteResponse(id: string): Promise<void> {
  redis.del(responseKey(id))
    .catch((err: unknown) => log.warn({ err }, "Redis error in deleteResponse"));
}
