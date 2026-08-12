/**
 * Pure helper functions for model provider resolution and per-driver tags.
 * Safe to import from both server and client code (no runtime deps).
 */
import { type LegacyModel, type Provider, ProviderEnum } from "./definitions/model-definition";
import { type RequestParamType } from "./definitions/model-primitives";

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Returns the provider-specific model name and driver for the preferred
 * provider. Preference order follows ProviderEnum (vllm first, then ollama).
 */
export function resolveDefaultProvider(model: LegacyModel): { driver: Provider; providerModel: string } | undefined {
  for (const driver of ProviderEnum.options) {
    const providerModel = model.providers[driver];
    if (providerModel) return { driver, providerModel };
  }
  return undefined;
}

/** Returns the provider-specific model name for a given driver, or undefined. */
export function resolveProvider(model: LegacyModel, driver: Provider): string | undefined {
  return model.providers[driver];
}

// ---------------------------------------------------------------------------
// Tag resolution
// ---------------------------------------------------------------------------

/**
 * Returns tags for a specific driver. When providerTags is present for
 * that driver, uses those; otherwise falls back to model-level tags.
 */
export function resolveTagsForDriver(model: LegacyModel, driver: Provider): string[] {
  return model.providerTags?.[driver] ?? model.tags ?? [];
}

/**
 * Returns the union of all driver-specific tags for the model.
 * Used for filtering and search in the model selector where the
 * driver is not yet known.
 */
export function resolveAllTags(model: LegacyModel): string[] {
  const tagSet = new Set(model.tags ?? []);
  for (const driverTags of Object.values(model.providerTags ?? {})) {
    if (driverTags) {
      for (const tag of driverTags) tagSet.add(tag);
    }
  }
  return [...tagSet];
}

/** Checks whether a specific driver has a given tag. */
export function driverHasTag(model: LegacyModel, driver: Provider, tag: string): boolean {
  return resolveTagsForDriver(model, driver).includes(tag);
}

// ---------------------------------------------------------------------------
// Version requirements
// ---------------------------------------------------------------------------

/** Returns the minimum driver version required for a specific driver, or undefined. */
export function resolveMinVersionForDriver(model: LegacyModel, driver: Provider): string | undefined {
  return model.providerMinVersions?.[driver];
}

/** Returns the GPU platforms required for a specific driver, or empty array (= any). */
export function resolveRequiredPlatformsForDriver(model: LegacyModel, driver: Provider): string[] {
  return model.providerPlatforms?.[driver] ?? [];
}

// ---------------------------------------------------------------------------
// Required features resolution
// ---------------------------------------------------------------------------

/** Returns driver features required by the model's type, or empty array. */
export function resolveRequiredFeaturesForDriver(model: LegacyModel, driver: Provider): string[] {
  if (driver === "vllm" && model.type === "transcription") return ["audio"];
  return [];
}

// ---------------------------------------------------------------------------
// Provider args resolution
// ---------------------------------------------------------------------------

/**
 * Returns extra CLI arguments for a specific driver.
 * Returns an empty array if providerArgs is absent or has no entry for the driver.
 */
export function resolveArgsForDriver(model: LegacyModel, driver: Provider): string[] {
  return model.providerArgs?.[driver] ?? [];
}

// ---------------------------------------------------------------------------
// Request params resolution
// ---------------------------------------------------------------------------

/** Flat map of dot-path to primitive type name. Empty record means no passthrough. */
export type RequestParamMap = Record<string, RequestParamType>;

/**
 * Returns the allowed request-level passthrough parameters for a specific driver.
 * Returns an empty record if requestParams is absent or has no entry for the driver.
 */
export function resolveRequestParamsForDriver(model: LegacyModel, driver: Provider): RequestParamMap {
  return model.requestParams?.[driver] ?? {};
}
