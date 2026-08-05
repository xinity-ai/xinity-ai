/**
 * Pure resolution core shared by the run-model and print-vllm-command scripts.
 *
 * Turns a model-file entry plus a target machine's hardware profile into the
 * facts needed to build a vLLM command and to decide whether the model may run
 * here at all. Imports only xinity-infoserver so it stays free of the daemon's
 * runtime/db dependencies and is cheap to unit-test.
 */
import {
  checkNodeCompatibility,
  requiredFeaturesForEngine,
  type Model,
  type NodeCapability,
  type ModelNodeRequirements,
  type IncompatibilityReason,
} from "xinity-infoserver";

/** Minimal machine description the resolver needs; a subset of HardwareProfile. */
export interface MachineProfile {
  gpus: Array<{ vendor: string; name: string; vramMb: number }>;
  /** Usable model capacity in GB (total, treated as free on an empty standalone node). */
  detectedCapacityGb: number;
}

/** A model entry resolved for vLLM, with the derived run facts. */
export interface ResolvedVllmModel {
  /** The HuggingFace-style name vLLM and the downloader use. */
  vllmProviderName: string;
  model: Model;
  trustRemoteCode: boolean;
  hasToolsTag: boolean;
  args: string[];
  modelType: string | undefined;
  /** KV-cache allocation in GB: max(override, model.minKvCache). */
  kvCacheGb: number;
  /** Total VRAM the install is expected to occupy: weight + kvCacheGb. Mirrors orchestration.mod.ts. */
  estCapacity: number;
  minVersion: string | undefined;
  requiredPlatforms: string[];
  requiredFeatures: string[];
}

export class RunModelError extends Error {}

/**
 * Accepts either a public specifier (a key in `models:`) or an `engineSpecifier`.
 * Throws RunModelError with a human-readable message when not found or not a vllm entry.
 */
export function findVllmModel(
  parsed: { models: Record<string, Model> },
  name: string,
): { vllmProviderName: string; model: Model } {
  const direct = parsed.models[name];
  if (direct) {
    if (direct.engine !== "vllm") {
      throw new RunModelError(`Model "${name}" runs on ${direct.engine}, not vllm; cannot build a vllm command for it.`);
    }
    return { vllmProviderName: direct.engineSpecifier, model: direct };
  }
  for (const model of Object.values(parsed.models)) {
    if (model.engine === "vllm" && model.engineSpecifier === name) {
      return { vllmProviderName: name, model };
    }
  }
  const known = Object.keys(parsed.models).join(", ");
  throw new RunModelError(
    `Model "${name}" not found (looked at public specifiers and engineSpecifier values). Known: ${known}`,
  );
}

/**
 * Resolves a model file entry into the facts needed to run it under vLLM.
 * `kvCacheGbOverride`, when given, raises the floor set by model.minKvCache.
 */
export function resolveVllmModel(
  parsed: { models: Record<string, Model> },
  name: string,
  options: { kvCacheGbOverride?: number } = {},
): ResolvedVllmModel {
  const { vllmProviderName, model } = findVllmModel(parsed, name);

  const tags = model.tags ?? [];
  const kvCacheGb = Math.max(options.kvCacheGbOverride ?? 0, model.minKvCache);

  return {
    vllmProviderName,
    model,
    trustRemoteCode: tags.includes("custom_code"),
    hasToolsTag: tags.includes("tools"),
    args: model.args ?? [],
    modelType: model.type,
    kvCacheGb,
    estCapacity: model.weight + kvCacheGb,
    minVersion: model.minEngineVersion,
    requiredPlatforms: model.platforms ?? [],
    requiredFeatures: requiredFeaturesForEngine("vllm", model.type),
  };
}

/** Whether the vLLM driver is usable on this machine, and its version if detectable. */
export interface VllmDriverState {
  available: boolean;
  version?: string;
  features?: string[];
}

/**
 * Builds the NodeCapability for the gate from a detected hardware profile and
 * the vLLM driver state. An absent driver omits the key (→ `missing_driver`);
 * a present-but-undetectable version maps to an empty string (→ `version_unknown`).
 */
export function toNodeCapability(profile: MachineProfile, driver: VllmDriverState): NodeCapability {
  return {
    free: profile.detectedCapacityGb,
    driverVersions: driver.available ? { vllm: driver.version ?? "" } : {},
    driverFeatures: driver.available && driver.features?.length ? { vllm: driver.features } : {},
    gpus: profile.gpus,
  };
}

export function toModelRequirements(resolved: ResolvedVllmModel): ModelNodeRequirements {
  return {
    driver: "vllm",
    capacityGb: resolved.estCapacity,
    minVersion: resolved.minVersion,
    requiredPlatforms: resolved.requiredPlatforms,
    requiredFeatures: resolved.requiredFeatures,
  };
}

/**
 * Runs the compatibility gate. Returns the first failing reason, or null when
 * the model may run on this machine. `requireKnownVersion` makes an undetectable
 * vLLM version a hard failure, which is what `--start` wants.
 */
export function checkVllmCompatibility(
  resolved: ResolvedVllmModel,
  profile: MachineProfile,
  driver: VllmDriverState,
  options: { requireKnownVersion?: boolean } = {},
): IncompatibilityReason | null {
  return checkNodeCompatibility(
    toNodeCapability(profile, driver),
    toModelRequirements(resolved),
    options,
  );
}

export function describeIncompatibility(
  reason: IncompatibilityReason,
  resolved: ResolvedVllmModel,
  profile: MachineProfile,
  driver: VllmDriverState,
): string {
  switch (reason) {
    case "missing_driver":
      return "vLLM driver not available (no vllm binary or docker image resolved).";
    case "version_unknown":
      return `Could not detect the installed vLLM version, and this model requires >= ${resolved.minVersion}.`;
    case "version_too_old":
      return `Installed vLLM ${driver.version} is older than the required >= ${resolved.minVersion}.`;
    case "missing_feature": {
      const have = driver.features?.join(", ") || "none";
      return `Model requires features [${resolved.requiredFeatures.join(", ")}]; this installation has [${have}].`;
    }
    case "wrong_platform": {
      const have = profile.gpus.map(g => g.vendor).join(", ") || "none";
      return `Model requires GPU platform [${resolved.requiredPlatforms.join(", ")}]; this machine has [${have}].`;
    }
    case "insufficient_capacity":
      return `Model needs ~${resolved.estCapacity}GB but only ${profile.detectedCapacityGb}GB is available.`;
  }
}
