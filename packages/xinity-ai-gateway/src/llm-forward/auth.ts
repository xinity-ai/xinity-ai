import { aiApiKeyT, sql, hashApiKey, apiKeyVerifier, SHA256_VERIFIER_PREFIX, type AiApiKey } from "common-db";
import { getDB } from "../db";
import { redis } from "bun";
import { timingSafeEqual } from "node:crypto";
import { rootLogger } from "../logger";
import { createSemaphore } from "../semaphore";
import { errorResponse } from "./util";

const log = rootLogger.child({ name: "auth" });


function genericUnauthorized(detail?: string) {
  return new Response(JSON.stringify({
    error: {
      message: detail ?? "Unauthorized",
      type: "authentication_error",
      param: null,
      code: null,
    },
  }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

export type AuthResult = {
  keyId: string;
  orgId: string;
  applicationId: string | null;
  collectData: boolean;
}

function toAuthResult(key: { id: string; organizationId: string; applicationId: string | null; collectData: boolean }): AuthResult {
  return {
    keyId: key.id,
    orgId: key.organizationId,
    applicationId: key.applicationId,
    collectData: key.collectData,
  };
}

/** map to keep track of ongoing auth checks, to deal with sudden bursts of requests from the same key */
const inflightAuth = new Map<string, Promise<Response | AuthResult>>();

const BEARER_PREFIX = "Bearer ";
const API_KEY_SPECIFIER_LENGTH = 25;

/** Leaves most of the (default 10) Postgres connections for everything else. */
const MAX_CONCURRENT_VERIFICATIONS = 3;
const VERIFY_QUEUE_TIMEOUT_MS = 2_000;
const verifyLimiter = createSemaphore(MAX_CONCURRENT_VERIFICATIONS);

export async function checkAuth(authHeader: string): Promise<Response | AuthResult> {
  if (!authHeader.startsWith(BEARER_PREFIX)) {
    return genericUnauthorized("Missing API Key");
  }
  const key = authHeader.substring(BEARER_PREFIX.length);
  const keyHash = hashApiKey(key);
  const cached = await getApiKeyCache(keyHash);
  if (cached) {
    return "fail" in cached ? genericUnauthorized(cached.fail) : toAuthResult(cached);
  }

  const inflight = inflightAuth.get(key);
  if (inflight) return inflight;
  const promise = verifyWithinLimit(key, keyHash).finally(() => inflightAuth.delete(key));
  inflightAuth.set(key, promise);
  return promise;
}

async function verifyWithinLimit(key: string, keyHash: string): Promise<Response | AuthResult> {
  if (!await verifyLimiter.acquire(VERIFY_QUEUE_TIMEOUT_MS)) {
    log.warn({ waiting: verifyLimiter.waiting() }, "Auth verification capacity exhausted");
    return errorResponse("Server busy, please retry", 503, { "Retry-After": "1" });
  }
  try {
    return await verifyKeyAgainstDb(key, keyHash);
  } finally {
    verifyLimiter.release();
  }
}

async function verifyKeyAgainstDb(key: string, keyHash: string): Promise<Response | AuthResult> {
  const prefix = key.substring(0, API_KEY_SPECIFIER_LENGTH);
  const [apiKeyObj] = await getDB()
    .select()
    .from(aiApiKeyT)
    .where(sql`${aiApiKeyT.specifier} = ${prefix}`).limit(1);
  if (!apiKeyObj) {
    return rejectAndCache(keyHash, "API Key not found");
  }

  if (!apiKeyObj.enabled) {
    return rejectAndCache(keyHash, "API Key is disabled");
  }

  if (apiKeyObj.deletedAt) {
    return rejectAndCache(keyHash, "API Key has been deleted");
  }

  if (!await keyMatches(key, apiKeyObj)) {
    return rejectAndCache(keyHash, "Unauthorized");
  }
  setApiKeyCache(keyHash, pickAttrs(apiKeyObj));
  return toAuthResult(apiKeyObj);
}

async function keyMatches(key: string, apiKeyObj: AiApiKey): Promise<boolean> {
  if (apiKeyObj.hash.startsWith(SHA256_VERIFIER_PREFIX)) {
    return verifiersEqual(apiKeyVerifier(key), apiKeyObj.hash);
  }
  try {
    return await Bun.password.verify(key, apiKeyObj.hash);
  } catch (error) {
    log.error({ err: error }, "Auth verification failed");
    return false;
  }
}

function verifiersEqual(presented: string, stored: string): boolean {
  if (presented.length !== stored.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(presented), Buffer.from(stored));
}

/** Caching the rejection keeps a flood of bad keys off the DB and out of argon2. */
function rejectAndCache(keyHash: string, detail: string): Response {
  setApiKeyCache(keyHash, { fail: detail }, AUTH_FAILURE_CACHE_TTL_SECONDS);
  return genericUnauthorized(detail);
}

type PartialApiKey = Pick<AiApiKey, "organizationId" | "id" | "applicationId" | "collectData">;
type CachedAuth = PartialApiKey | { fail: string };

/** Curried pick: returns a fn that copies the given keys from an object. */
function pick<K extends PropertyKey>(keys: readonly K[]) {
  return <T extends Record<K, unknown>>(obj: T): Pick<T, K> => {
    const result = {} as Pick<T, K>;
    for (const key of keys) result[key] = obj[key];
    return result;
  };
}

const pickAttrs = pick(["organizationId", "id", "applicationId", "collectData"] satisfies (keyof AiApiKey)[]);
const API_KEY_CACHE_TTL_SECONDS = 120;
/** Short enough that re-enabling a key takes effect promptly. */
const AUTH_FAILURE_CACHE_TTL_SECONDS = 10;
const L1_AUTH_CACHE_TTL_MS = 5_000;

type L1AuthEntry = { data: CachedAuth; expiresAt: number };
const l1AuthCache = new Map<string, L1AuthEntry>();

/** Clears the in-memory L1 auth cache. Exported for tests and invalidation. */
export function clearAuthCache(): void {
  l1AuthCache.clear();
}

const apiKeyCacheKey = (identifier: string) => `apikey:${identifier}`;

function setApiKeyCache(
  identifier: string,
  data: CachedAuth,
  ttlSeconds: number = API_KEY_CACHE_TTL_SECONDS,
): void {
  const l1Ttl = Math.min(ttlSeconds * 1000, L1_AUTH_CACHE_TTL_MS);
  l1AuthCache.set(identifier, { data, expiresAt: Date.now() + l1Ttl });

  void redis.set(apiKeyCacheKey(identifier), JSON.stringify(data), "EX", ttlSeconds)
    .catch((err: unknown) => log.warn({ err }, "Redis error in setApiKeyCache"));
}

async function getApiKeyCache(identifier: string): Promise<CachedAuth | null> {
  const now = Date.now();
  const l1 = l1AuthCache.get(identifier);
  if (l1 && l1.expiresAt > now) {
    return l1.data;
  }

  try {
    const result = await redis.get(apiKeyCacheKey(identifier));
    if (!result) return null;
    const parsed = JSON.parse(result);
    const resolved: CachedAuth = typeof parsed.fail === "string"
      ? (parsed as { fail: string })
      : { collectData: true, ...parsed };

    l1AuthCache.set(identifier, { data: resolved, expiresAt: now + L1_AUTH_CACHE_TTL_MS });
    return resolved;
  } catch (err) {
    log.warn({ err }, "Redis error in getApiKeyCache");
    return null;
  }
}