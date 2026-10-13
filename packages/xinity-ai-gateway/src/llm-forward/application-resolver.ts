import { aiApplicationT, sql } from "common-db";
import { getDB } from "../db";
import { cache } from "../cache";
import { rootLogger } from "../logger";
import { config } from "../config";

const log = rootLogger.child({ name: "application-resolver" });

/**
 * Resolves an application name to its ID within an organization.
 * Cached to avoid repeated DB lookups.
 * Returns the application ID or null if not found / soft-deleted.
 */
export async function resolveApplicationByName(
  name: string,
  organizationId: string,
): Promise<string | null> {
  const cacheKey = `app:${organizationId}:${name}`;

  try {
    const cached = await cache.get(cacheKey);
    if (cached) return cached;
  } catch (err) {
    log.warn({ err }, "Cache error in resolveApplicationByName (get)");
  }

  const [app] = await getDB()
    .select({ id: aiApplicationT.id })
    .from(aiApplicationT)
    .where(
      sql`
        ${aiApplicationT.name} = ${name}
      AND
        ${aiApplicationT.organizationId} = ${organizationId}
      AND
        ${aiApplicationT.deletedAt} IS NULL
      `
    )
    .limit(1);

  if (!app) return null;

  cache.set(cacheKey, app.id, config.cache.applicationTtlSeconds())
    .catch((err: unknown) => log.warn({ err }, "Cache error in resolveApplicationByName (set)"));
  return app.id;
}
