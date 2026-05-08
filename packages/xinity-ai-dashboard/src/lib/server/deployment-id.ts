import { deploymentConfigT } from "common-db";
import { getDB } from "./db";
import { rootLogger } from "./logging";

const log = rootLogger.child({ name: "deployment-id" });

let cachedInstanceId: string | null = null;
let loadPromise: Promise<string> | null = null;

async function raceSafeInsertSingleton(): Promise<{ row: { instanceId: string }; inserted: boolean }> {
  const db = getDB();
  const inserted = await db
    .insert(deploymentConfigT)
    .values({ singleton: 1 })
    .onConflictDoNothing({ target: deploymentConfigT.singleton })
    .returning();
  if (inserted.length > 0) return { row: inserted[0], inserted: true };

  const existing = await db.select().from(deploymentConfigT).limit(1);
  if (existing.length === 0) {
    throw new Error("deployment_config row missing after singleton upsert");
  }
  return { row: existing[0], inserted: false };
}

/**
 * Reads the singleton row from `deployment_config`, inserting one if missing,
 * and caches the resulting instance ID for the process lifetime.
 *
 * Safe to call multiple times - concurrent callers share the same in-flight load.
 * On failure the in-flight promise is cleared so transient DB errors can be retried.
 */
export async function loadDeploymentId(): Promise<string> {
  if (cachedInstanceId) return cachedInstanceId;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const db = getDB();
      const existing = await db.select().from(deploymentConfigT).limit(1);
      if (existing.length > 0) {
        cachedInstanceId = existing[0].instanceId;
        log.info({ instanceId: cachedInstanceId }, "Loaded deployment instance ID");
        return cachedInstanceId;
      }

      const { row, inserted } = await raceSafeInsertSingleton();
      cachedInstanceId = row.instanceId;
      log.info(
        { instanceId: cachedInstanceId },
        inserted ? "Generated deployment instance ID" : "Loaded deployment instance ID",
      );
      return cachedInstanceId;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

/**
 * Returns the cached deployment instance ID, or null if `loadDeploymentId()`
 * has not yet completed. License checks treat null as "cannot verify".
 */
export function getDeploymentId(): string | null {
  return cachedInstanceId;
}

/** Resets the cached deployment ID (test-only). */
export function resetDeploymentIdCache(): void {
  cachedInstanceId = null;
  loadPromise = null;
}
