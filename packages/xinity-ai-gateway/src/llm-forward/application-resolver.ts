import { aiApplicationT, sql, isNull } from "common-db";
import { getDB } from "../db";
import { redis } from "bun";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "application-resolver" });

const APP_CACHE_TTL_SECONDS = 5 * 60; // 5 minutes

/**
 * Resolves an application name to its ID within an organization.
 * Uses Redis cache to avoid repeated DB lookups.
 * Returns the application ID or null if not found / soft-deleted.
 */
export async function resolveApplicationByName(
  name: string,
  organizationId: string,
): Promise<string | null> {
  const cacheKey = `app:${organizationId}:${name}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return cached;
  } catch (err) {
    log.warn({ err }, "Redis error in resolveApplicationByName (get)");
  }

  const [app] = await getDB()
    .select({ id: aiApplicationT.id })
    .from(aiApplicationT)
    .where(
      sql`${aiApplicationT.name} = ${name} AND ${aiApplicationT.organizationId} = ${organizationId} AND ${isNull(aiApplicationT.deletedAt)}`
    )
    .limit(1);

  if (!app) return null;

  redis.set(cacheKey, app.id, "EX", APP_CACHE_TTL_SECONDS)
    .catch((err: unknown) => log.warn({ err }, "Redis error in resolveApplicationByName (set)"));
  return app.id;
}
