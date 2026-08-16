/**
 * Server-side model resolution for scheduling. Answers from the current catalog and
 * falls back to the deprecated one, so deployments created before the per-engine
 * format keep being placed.
 */
import { building } from "$app/environment";
import {
  createCatalogClient,
  createInfoserverClient,
  mibToGb,
  requiredFeaturesForEngine,
  resolveDefaultProvider,
  resolveMinVersionForDriver,
  resolveRequiredFeaturesForDriver,
  resolveRequiredPlatformsForDriver,
  type Provider,
} from "xinity-infoserver";
import { serverEnv } from "./serverenv";
import { rootLogger } from "./logging";

const log = rootLogger.child({ name: "model-catalog" });

export const catalogClient = building ? null : createCatalogClient({
  baseUrl: serverEnv.INFOSERVER_URL,
  cacheTtlMs: serverEnv.INFOSERVER_CACHE_TTL_MS,
  logger: log,
});

/** Everything scheduling needs about a model, with the engine already decided. */
export type SchedulableModel = {
  specifier: string;
  driver: Provider;
  type: string | undefined;
  weight: number;
  minKvCache: number;
  minVersion: string | undefined;
  requiredPlatforms: string[];
  requiredFeatures: string[];
};

export type CatalogResolution =
  | { status: "found"; model: SchedulableModel }
  | { status: "not_found" }
  | { status: "unavailable"; error: string };

/**
 * `preferredDriver` only applies to the deprecated format, where one entry could run
 * on either engine. A current-format entry names its engine, which wins.
 */
export async function resolveSchedulable(
  specifier: string,
  preferredDriver: Provider | null,
): Promise<CatalogResolution> {
  if (!catalogClient) {
    return { status: "unavailable", error: "Catalog client is not available during build" };
  }

  const result = await catalogClient.lookup(specifier);
  if (result.status === "unavailable") {
    return result;
  }
  if (result.status === "found") {
    const model = result.model;
    return {
      status: "found",
      model: {
        specifier,
        driver: model.engine,
        type: model.type,
        weight: mibToGb(model.sizing.weightMib),
        minKvCache: mibToGb(model.sizing.minKvCacheMib),
        minVersion: model.minEngineVersion,
        requiredPlatforms: model.platforms ?? [],
        requiredFeatures: requiredFeaturesForEngine(model.engine, model.type),
      },
    };
  }
  return legacySchedulable(specifier, preferredDriver);
}

/**
 * Whether a specifier is served only by the deprecated catalog. Surfaced per deployment
 * so the ones that still need moving are visible before `MODEL_LEGACY_DIR` is dropped,
 * rather than after. Goes away with the legacy catalog itself.
 */
export async function resolvesOnlyAsLegacy(specifier: string | null): Promise<boolean> {
  if (!specifier || !catalogClient) {
    return false;
  }
  const current = await catalogClient.lookup(specifier);
  if (current.status !== "not_found") {
    return false;
  }
  return (await legacySchedulable(specifier, null)).status === "found";
}

/** Removed before 1.0.0, along with the client it reads. */
async function legacySchedulable(specifier: string, preferredDriver: Provider | null): Promise<CatalogResolution> {
  const status = await legacyClient().fetchModelStatus(specifier);
  if (status.status !== "found") {
    return status;
  }

  const model = status.model;
  const driver = preferredDriver && model.providers[preferredDriver]
    ? preferredDriver
    : resolveDefaultProvider(model)?.driver;
  if (!driver) {
    log.warn({ specifier }, "Deprecated catalog entry declares no usable provider");
    return { status: "not_found" };
  }

  return {
    status: "found",
    model: {
      specifier,
      driver,
      type: model.type,
      weight: model.weight,
      minKvCache: model.minKvCache,
      minVersion: resolveMinVersionForDriver(model, driver),
      requiredPlatforms: resolveRequiredPlatformsForDriver(model, driver),
      requiredFeatures: resolveRequiredFeaturesForDriver(model, driver),
    },
  };
}

let _legacyClient: ReturnType<typeof createInfoserverClient> | null = null;
function legacyClient() {
  _legacyClient ??= createInfoserverClient({
    baseUrl: serverEnv.INFOSERVER_URL,
    cacheTtlMs: serverEnv.INFOSERVER_CACHE_TTL_MS,
    logger: log,
  });
  return _legacyClient;
}
