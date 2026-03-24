/**
 * Pure helper functions for model provider resolution and per-driver tags.
 * Safe to import from both server and client code (no runtime deps).
 */
import { type Model, type Provider, type RequestParamType, ProviderEnum } from "./definitions/model-definition";

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Returns the provider-specific model name and driver for the preferred
 * provider. Preference order follows ProviderEnum (vllm first, then ollama).
 */
export function resolveDefaultProvider(model: Model): { driver: Provider; providerModel: string } | undefined {
  for (const driver of ProviderEnum.options) {
    const providerModel = model.providers[driver];
    if (providerModel) return { driver, providerModel };
  }
  return undefined;
}

/** Returns the provider-specific model name for a given driver, or undefined. */
export function resolveProvider(model: Model, driver: Provider): string | undefined {
  return model.providers[driver];
}

/** Determines which driver a provider-specific model name belongs to. */
export function resolveDriverForProviderModel(model: Model, providerModel: string): Provider | undefined {
  for (const [driver, spec] of Object.entries(model.providers) as [Provider, string | undefined][]) {
    if (spec === providerModel) return driver;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tag resolution
// ---------------------------------------------------------------------------

/**
 * Returns tags for a specific driver. When providerTags is present for
 * that driver, uses those; otherwise falls back to model-level tags.
 */
export function resolveTagsForDriver(model: Model, driver: Provider): string[] {
  const driverKey = driver as Provider;
  return model.providerTags?.[driverKey] ?? model.tags ?? [];
}

/**
 * Returns the union of all driver-specific tags for the model.
 * Used for filtering and search in the model selector where the
 * driver is not yet known.
 */
export function resolveAllTags(model: Model): string[] {
  if (!model.providerTags) return model.tags ?? [];

  const tagSet = new Set(model.tags ?? []);
  for (const driverTags of Object.values(model.providerTags)) {
    if (driverTags) {
      for (const tag of driverTags) tagSet.add(tag);
    }
  }
  return [...tagSet];
}

/** Checks whether a specific driver has a given tag. */
export function driverHasTag(model: Model, driver: Provider, tag: string): boolean {
  return resolveTagsForDriver(model, driver).includes(tag);
}

// ---------------------------------------------------------------------------
// Provider args resolution
// ---------------------------------------------------------------------------

/**
 * Returns extra CLI arguments for a specific driver.
 * Returns an empty array if providerArgs is absent or has no entry for the driver.
 */
export function resolveArgsForDriver(model: Model, driver: Provider): string[] {
  return model.providerArgs?.[driver as Provider] ?? [];
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
export function resolveRequestParamsForDriver(model: Model, driver: Provider): RequestParamMap {
  return model.requestParams?.[driver as Provider] ?? {};
}
