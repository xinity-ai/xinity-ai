import { redis } from "bun";
import type { ApiCallInputMessage } from "common-db";
import { env } from "../env";
import { rootLogger } from "../logger";
import {
  createPersistedResponse,
  settlePersistedResponse,
  loadResponse,
  loadResponseMessages,
  deletePersistedResponse,
  type ResponseOwner,
} from "./responses/persistence";
import type { ResponseObject } from "./responses/schemas";

const log = rootLogger.child({ name: "response-store" });

const responseKey = (orgId: string, id: string) => `response:${orgId}:${id}`;

/** Only the creating write can supply these; later writes are recognized by status. */
export type ResponseCreation = {
  apiKeyId: string | null;
  applicationId: string | null;
  inputMessages: ApiCallInputMessage[];
};

async function cacheResponse(orgId: string, id: string, payload: unknown): Promise<void> {
  await redis.set(responseKey(orgId, id), JSON.stringify(payload), "EX", env.RESPONSE_CACHE_TTL_SECONDS);
}

/**
 * Postgres failures are logged rather than thrown: Redis already holds the response, so
 * the request can still be served for the cache window.
 */
async function persist(orgId: string, response: ResponseObject, creation?: ResponseCreation): Promise<void> {
  const owner: ResponseOwner = {
    orgId,
    apiKeyId: creation?.apiKeyId ?? null,
    applicationId: creation?.applicationId ?? null,
  };
  try {
    if (response.status === "in_progress") {
      if (creation) {
        await createPersistedResponse({ response, ...owner, inputMessages: creation.inputMessages });
      }
      return;
    }
    if (!await settlePersistedResponse(orgId, response)) {
      log.warn({ responseId: response.id, status: response.status }, "No in-progress row to settle");
    }
  } catch (err) {
    log.error({ err, responseId: response.id }, "Failed to persist response");
  }
}

export async function saveResponse(
  orgId: string,
  id: string,
  response: ResponseObject,
  creation?: ResponseCreation,
): Promise<void> {
  await cacheResponse(orgId, id, response);
  if (response.store === false) {
    return;
  }
  await persist(orgId, response, creation);
}

export async function getResponse(orgId: string, id: string): Promise<unknown | null> {
  let payload: string | null;
  try {
    payload = await redis.get(responseKey(orgId, id));
  } catch (err) {
    log.warn({ err }, "Redis error in getResponse");
    payload = null;
  }

  if (payload) {
    try {
      return JSON.parse(payload);
    } catch (err) {
      log.error({ err, responseId: id }, "Corrupted response data in Redis");
    }
  }

  const stored = await loadResponse(orgId, id);
  if (!stored) {
    return null;
  }
  await cacheResponse(orgId, id, stored)
    .catch((err) => log.warn({ err, responseId: id }, "Failed to re-cache response"));
  return stored;
}

/**
 * The messages a stored response was built from. Only Postgres holds these; the Redis entry is
 * the response object, which carries the answer but not the question. Empty for a response
 * created with `store: false`, which is never written to Postgres at all.
 */
export function getResponseMessages(orgId: string, id: string): Promise<ApiCallInputMessage[]> {
  return loadResponseMessages(orgId, id);
}

/** Returns false when the entry could not be removed, so callers do not report a delete that did not happen. */
export async function deleteResponse(orgId: string, id: string): Promise<boolean> {
  try {
    await redis.del(responseKey(orgId, id));
    await deletePersistedResponse(orgId, id);
    return true;
  } catch (err) {
    log.warn({ err }, "Error in deleteResponse");
    return false;
  }
}
