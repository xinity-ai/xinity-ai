import { redis } from "bun";
import { env } from "../env";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "response-store" });

const responseKey = (orgId: string, id: string) => `response:${orgId}:${id}`;

export async function saveResponse(orgId: string, id: string, payload: unknown): Promise<void> {
  await redis.set(
    responseKey(orgId, id),
    JSON.stringify(payload),
    "EX",
    env.RESPONSE_CACHE_TTL_SECONDS
  );
}

export async function getResponse(orgId: string, id: string): Promise<unknown | null> {
  let payload: string | null;
  try {
    payload = await redis.getex(
      responseKey(orgId, id),
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

export function deleteResponse(orgId: string, id: string): void {
  redis.del(responseKey(orgId, id))
    .catch((err: unknown) => log.warn({ err }, "Redis error in deleteResponse"));
}
