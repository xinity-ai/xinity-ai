import { getDB, listen } from "../db/connection";
import { modelInstallationT, modelInstallationStateT, sql, type ModelInstallation } from "common-db";
import { getNodeId, getNodeDrivers } from "./statekeeper";
import { defer, from, Observable } from "rxjs";
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

const log = rootLogger.child({ name: "db-sync" });

let previousInstallationsSnapshot: string | null = null;

function logInstallationsIfChanged(installations: ModelInstallation[]): void {
  const models = installations.map(({ driver, model, estCapacity }) => ({ driver, model, estCapacity }));
  const snapshot = JSON.stringify(models);
  if (snapshot === previousInstallationsSnapshot) return;
  previousInstallationsSnapshot = snapshot;
  log.info({ models }, "Installations changed");
}

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

/** Appends an empty bucket for every supported driver missing from the existing buckets, so stale models on those drivers get cleaned up. */
function ensureBucketsForSupportedDrivers<T>(
  buckets: Array<{ driver: string; installations: T[] }>,
  supportedDrivers: readonly string[],
): void {
  for (const driver of supportedDrivers) {
    if (!buckets.some((b) => b.driver === driver)) {
      buckets.push({ driver, installations: [] });
    }
  }
}

/** Mark installations on an unsupported driver as failed so they aren't retried indefinitely. */
function syncUnsupportedDriver$(
  driver: string,
  installations: Array<{ id: string; model: string }>
): Observable<void> {
  return defer(() => {
    log.warn(
      { driver, models: installations.map((i) => i.model) },
      "Skipping unsupported driver"
    );
    const failedState = {
      lifecycleState: "failed" as const,
      errorMessage: `Unsupported driver: ${driver}`,
    };
    return from(
      Promise.all(
        installations.map((i) =>
          getDB()
            .insert(modelInstallationStateT)
            .values({ id: i.id, ...failedState })
            .onConflictDoUpdate({ set: failedState, target: modelInstallationStateT.id })
        )
      )
    );
  }).pipe(ignoreElements(), endWith(void 0));
}

function syncForDriver$(driver: string, installations: ModelInstallation[]): Observable<void> {
  if (driver === "ollama") return syncOllamaInstallations$(installations);
  if (driver === "vllm") return syncVllmInstallations$(installations);
  return syncUnsupportedDriver$(driver, installations);
}

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
      ensureBucketsForSupportedDrivers(buckets, getNodeDrivers());
      logInstallationsIfChanged(installations);
      return from(buckets).pipe(
        mergeMap(({ driver, installations: driverInstallations }) =>
          syncForDriver$(driver, driverInstallations), DRIVER_SYNC_CONCURRENCY),
        ignoreElements(),
        endWith(void 0)
      );
    })
  );
}
