import type { DesiredInstallation } from "common-env";
import { defer, from, type Observable } from "rxjs";
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
import { updateInstallationState } from "./model-installation/state";
import { getNodeId, getNodeDrivers } from "./statekeeper";

const log = rootLogger.child({ name: "db-sync" });

let latestInstallations: DesiredInstallation[] = [];
let previousInstallationsSnapshot: string | null = null;

export function setDesiredInstallations(installations: DesiredInstallation[]): void {
  latestInstallations = installations;
}

export function getDesiredInstallations(): DesiredInstallation[] {
  return latestInstallations;
}

export interface SyncInstallation {
  id: string;
  specifier: string;
  driver: string;
  estCapacity: number;
  kvCacheCapacity: number;
  port: number;
  settings: Record<string, number>;
  nodeId: string;
}

function toSyncInstallation(d: DesiredInstallation, nodeId: string): SyncInstallation {
  return {
    id: d.installationId,
    specifier: d.specifier,
    driver: d.driver,
    estCapacity: d.estCapacity,
    kvCacheCapacity: d.kvCacheCapacity,
    port: d.port,
    settings: d.settings,
    nodeId,
  };
}

function logInstallationsIfChanged(installations: SyncInstallation[]): void {
  const models = installations.map(({ driver, specifier, estCapacity }) => ({ driver, specifier, estCapacity }));
  const snapshot = JSON.stringify(models);
  if (snapshot === previousInstallationsSnapshot) {
    return;
  }
  previousInstallationsSnapshot = snapshot;
  log.info({ models }, "Installations changed");
}

export function dbSync() {
  return createWorkflowCoordinator({
    periodMs: env.SYNC_INTERVAL_MS,
    run: sync,
    onError(err, trigger) {
      log.error({ err, trigger }, "Error during sync");
    },
    onDrop(trigger) {
      log.warn({ trigger }, "Sync trigger dropped (queue full)");
    },
  });
}

const DRIVER_SYNC_CONCURRENCY = 1;

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

function syncUnsupportedDriver$(
  driver: string,
  installations: Array<{ id: string; specifier: string }>,
): Observable<void> {
  return defer(() => {
    log.warn(
      { driver, models: installations.map((i) => i.specifier) },
      "Skipping unsupported driver",
    );
    return from(
      Promise.all(
        installations.map((i) =>
          updateInstallationState(i.id, "failed", {
            errorMessage: `Unsupported driver: ${driver}`,
          }),
        ),
      ),
    );
  }).pipe(ignoreElements(), endWith(void 0));
}

function syncForDriver$(driver: string, installations: SyncInstallation[]): Observable<void> {
  if (driver === "ollama") {
    return syncOllamaInstallations$(installations);
  }
  if (driver === "vllm") {
    return syncVllmInstallations$(installations);
  }
  return syncUnsupportedDriver$(driver, installations);
}

function sync(): Observable<void> {
  log.debug("Performing sync");

  return defer(() => from(getNodeId())).pipe(
    switchMap((nodeId) => {
      const installations = latestInstallations.map(d => toSyncInstallation(d, nodeId));
      updateRegistry(installations);
      const buckets = groupInstallationsByDriver(installations);
      ensureBucketsForSupportedDrivers(buckets, getNodeDrivers());
      logInstallationsIfChanged(installations);
      return from(buckets).pipe(
        mergeMap(({ driver, installations: driverInstallations }) =>
          syncForDriver$(driver, driverInstallations), DRIVER_SYNC_CONCURRENCY),
        ignoreElements(),
        endWith(void 0),
      );
    }),
  );
}
