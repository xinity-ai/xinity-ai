import { getDB, listen } from "../db/connection";
import { modelInstallationT, modelInstallationStateT, sql } from "common-db";
import { getNodeId, getNodeDrivers } from "./statekeeper";
import { defer, from, merge, Observable } from "rxjs";
import {
  endWith,
  ignoreElements,
  mergeMap,
  switchMap,
} from "rxjs/operators";
import { syncOllamaInstallations$ } from "./model-installation/ollama";
import { syncVllmInstallations$ } from "./model-installation/vllm";
import { createWorkflowCoordinator } from "./sync-coordinator";
import { env } from "../env";
import { rootLogger } from "../logger";
import { groupInstallationsByDriver } from "./driver-grouping";
import { updateRegistry } from "./model-registry";
export { groupInstallationsByDriver };

const log = rootLogger.child({ name: "db-sync" });

let previousInstallationsSnapshot: string | null = null;

export function dbSync(){
  return createWorkflowCoordinator({
    periodMs: env.SYNC_INTERVAL_MS,
    run: sync,
    onError(err, trigger) {
      log.error({ err, trigger }, "Error during sync")
    },
    onDrop(trigger) {
      log.warn({ trigger }, "Sync trigger dropped (queue full)")
    },
  });
}

const DRIVER_SYNC_CONCURRENCY = 1;

/**
 * Placeholder for unsupported drivers. We explicitly no-op to keep the extension
 * point obvious and avoid silently dropping non-ollama installations.
 */
function syncUnsupportedDriver$(
  driver: string,
  installations: Array<{ id: string; model: string }>
): Observable<void> {
  return defer(() => {
    log.warn(
      { driver, models: installations.map((i) => i.model) },
      "Skipping unsupported driver"
    );
    return from(
      Promise.all(
        installations.map((i) =>
          getDB()
            .insert(modelInstallationStateT)
            .values({
              id: i.id,
              lifecycleState: "failed",
              errorMessage: `Unsupported driver: ${driver}`,
            })
            .onConflictDoUpdate({
              set: {
                lifecycleState: "failed",
                errorMessage: `Unsupported driver: ${driver}`,
              },
              target: modelInstallationStateT.id,
            })
        )
      )
    );
  }).pipe(ignoreElements(), endWith(void 0));
}

/**
 * Synchronizes all model installations by delegating to per-driver handlers.
 * Non-ollama drivers are explicitly no-ops for now.
 */
function sync(): Observable<void> {
  log.debug("Performing sync");

  return defer(() => from(getNodeId())).pipe(
    switchMap((nodeID) =>
      from(
        getDB().select().from(modelInstallationT).where(
          sql`${modelInstallationT.nodeId} = ${nodeID} AND ${modelInstallationT.deletedAt} IS NULL`
        )
      )
    ),
    switchMap((installations) => {
      updateRegistry(installations);
      const buckets = groupInstallationsByDriver(installations);
      // Include empty buckets for supported drivers to clean up stale models
      const supportedDrivers = getNodeDrivers();
      for (const driver of supportedDrivers) {
        if (!buckets.some(b => b.driver === driver)) {
          buckets.push({ driver, installations: [] });
        }
      }
      const models = installations.map(({ driver, model, estCapacity }) => ({ driver, model, estCapacity }));
      const snapshot = JSON.stringify(models);
      if (snapshot !== previousInstallationsSnapshot) {
        previousInstallationsSnapshot = snapshot;
        log.info({ models }, "Installations changed");
      }
      return from(buckets).pipe(
        mergeMap(({ driver, installations: driverInstallations }) => {
          if (driver === "ollama") {
            return syncOllamaInstallations$(driverInstallations);
          }
          if (driver === "vllm") {
            return syncVllmInstallations$(driverInstallations);
          }

          return syncUnsupportedDriver$(driver, driverInstallations);
        }, DRIVER_SYNC_CONCURRENCY),
        ignoreElements(),
        endWith(void 0)
      );
    })
  );
}
