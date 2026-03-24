import { pick } from "rambda";
import { aiApiKeyT, sql, type AIAPIKeyT } from "common-db";
import { getDB } from "../db";
import { redis } from "bun";
import { rootLogger } from "../logger";

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

export async function checkAuth(authHeader: string): Promise<Response | AuthResult> {
  if (!authHeader.startsWith("Bearer ")) {
    return genericUnauthorized("Missing API Key");
  }
  const key = authHeader.substring(7);
  const prefix = key.substring(0, 25);
  const secret = await getApiKeyCache(prefix);
  if (secret) {
    return {
      keyId: secret.id,
      orgId: secret.organizationId,
      applicationId: secret.applicationId,
      collectData: secret.collectData ?? true,
    };
  }
  const [apiKeyObj] = await getDB()
    .select()
    .from(aiApiKeyT)
    .where(sql`${aiApiKeyT.specifier} = ${prefix}`).limit(1);
  if (!apiKeyObj) {
    return genericUnauthorized("API Key not found");
  }

  if (!apiKeyObj.enabled) {
    return genericUnauthorized("API Key is disabled");
  }

  if (apiKeyObj.deletedAt) {
    return genericUnauthorized("API Key has been deleted");
  }

  try {
    const valid = await Bun.password.verify(key, apiKeyObj.hash)
    if (!valid) {
      return genericUnauthorized();
    }
  } catch (error) {
    log.error({ err: error }, "Auth verification failed");
    return genericUnauthorized()
  }
  setApiKeyCache(prefix, apiKeyObj);
  return {
    keyId: apiKeyObj.id,
    orgId: apiKeyObj.organizationId,
    applicationId: apiKeyObj.applicationId,
    collectData: apiKeyObj.collectData,
  };
}

type PartialApiKey = Pick<AIAPIKeyT, "organizationId" | "id" | "applicationId" | "collectData">;
const pickAttrs = pick(["organizationId", "id", "applicationId", "collectData"] satisfies (keyof AIAPIKeyT)[]);
async function setApiKeyCache(
  identifier: string,
  data: AIAPIKeyT,
  ttlSeconds: number = 60 * 60,
): Promise<void> {
  const key = `apikey:${identifier}`;
  redis.set(key, JSON.stringify(pickAttrs(data)), "EX", ttlSeconds)
    .catch((err: unknown) => log.warn({ err }, "Redis error in setApiKeyCache"));
}

async function getApiKeyCache(identifier: string, ttlSeconds = 60 * 60): Promise<PartialApiKey | null> {
  try {
    const key = `apikey:${identifier}`;
    const result = await redis.getex(key, "EX", ttlSeconds);
    if (!result) return null;
    const parsed = JSON.parse(result);
    // Handle old cache entries missing collectData (safe default during rolling deploy)
    return { collectData: true, ...parsed };
  } catch (err) {
    log.warn({ err }, "Redis error in getApiKeyCache");
    return null;
  }
}