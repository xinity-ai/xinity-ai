import { deploymentConfigT } from "common-db";
import { getDB } from "./db";
import { rootLogger } from "./logging";

const log = rootLogger.child({ name: "deployment-id" });

let cachedInstanceId: string | null = null;
let loadPromise: Promise<string> | null = null;

/**
 * Reads the singleton row from `deployment_config`, inserting one if missing,
 * and caches the resulting instance ID for the process lifetime.
 *
 * Safe to call multiple times - concurrent callers share the same in-flight load.
 */
export async function loadDeploymentId(): Promise<string> {
  if (cachedInstanceId) return cachedInstanceId;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const db = getDB();
    const existing = await db.select().from(deploymentConfigT).limit(1);
    if (existing.length > 0) {
      cachedInstanceId = existing[0].instanceId;
      log.info({ instanceId: cachedInstanceId }, "Loaded deployment instance ID");
      return cachedInstanceId;
    }

    const inserted = await db.insert(deploymentConfigT).values({}).returning();
    cachedInstanceId = inserted[0].instanceId;
    log.info({ instanceId: cachedInstanceId }, "Generated deployment instance ID");
    return cachedInstanceId;
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
