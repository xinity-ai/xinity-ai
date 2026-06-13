import { building } from "$app/environment";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { deleteS3Object } from "$lib/server/image-store";
import { runRetentionCycle } from "./retention.core";

const log = rootLogger.child({ name: "retention.service" });

const WARMUP_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 60 * 60_000; // hourly

function runCycle(): Promise<void> {
  return runRetentionCycle(getDB(), new Date(), deleteS3Object, log)
    .catch((err: unknown) => log.error({ err }, "Retention cycle failed"));
}

/**
 * Start the retention purge service. Checks hourly; purges each organization
 * with a configured policy at most once per day. The purge logic itself lives
 * in retention.core.ts (dependency-injected and unit-tested).
 */
export function startRetentionService(): void {
  if (building) return;
  log.info("Starting retention service");
  setTimeout(() => {
    void runCycle();
    setInterval(() => void runCycle(), CHECK_INTERVAL_MS);
  }, WARMUP_DELAY_MS);
}
