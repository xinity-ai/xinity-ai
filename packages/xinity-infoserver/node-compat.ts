/**
 * Consolidated model-node compatibility checking.
 * Single source of truth for "can this node serve this model?"
 * Pure functions with no DB or IO dependencies.
 */
import { satisfiesMinVersion } from "./semver";
import { mibToGb, type LegacyModel, type Model } from "./definitions/model-definition";

/** Per-GPU info as detected by the daemon and persisted on aiNodeT. */
export type GpuInfo = {
  vendor: string;
  name: string;
  vramMb: number;
};

/** Minimal representation of a node's capabilities.
 * Driver availability is determined by keys present in `driverVersions`:
 * if the daemon couldn't probe a version for a driver, that driver is unusable. */
export type NodeCapability = {
  free: number;
  driverVersions: Record<string, string>;
  driverFeatures?: Record<string, string[]>;
  gpus: GpuInfo[];
};

/** What a model needs from a node, resolved from model metadata for a specific driver. */
export type ModelNodeRequirements = {
  driver: string;
  capacityGb: number;
  minVersion?: string;
  requiredPlatforms: string[];
  requiredFeatures?: string[];
};

export type IncompatibilityReason =
  | "missing_driver"
  | "version_too_old"
  | "version_unknown"
  | "missing_feature"
  | "wrong_platform"
  | "insufficient_capacity";

/**
 * Checks whether a single node can serve a model.
 * Returns null if compatible, or the first failing reason.
 *
 * Check order: driver, version, platform, capacity.
 * This lets callers separate "structurally incompatible" from "just no capacity"
 * for greedy allocation loops.
 *
 * Fail-closed for gpus: if a model requires specific GPU platforms,
 * nodes with no GPUs or wrong vendors are excluded.
 */
export function checkNodeCompatibility(
  node: NodeCapability,
  req: ModelNodeRequirements,
  options: { requireKnownVersion?: boolean } = {},
): IncompatibilityReason | null {
  // TODO v1.0.0 default this to true
  const requireKnownVersion = options.requireKnownVersion ?? false;

  if (!(req.driver in node.driverVersions)) return "missing_driver";

  if (req.minVersion) {
    const nodeVersion = node.driverVersions[req.driver];
    if (!nodeVersion) {
      if (requireKnownVersion) return "version_unknown";
    } else if (!satisfiesMinVersion(nodeVersion, req.minVersion)) {
      return "version_too_old";
    }
  }

  if (req.requiredFeatures && req.requiredFeatures.length > 0) {
    const nodeFeatures = node.driverFeatures?.[req.driver] ?? [];
    if (!req.requiredFeatures.every(f => nodeFeatures.includes(f))) {
      return "missing_feature";
    }
  }

  if (req.requiredPlatforms.length > 0) {
    const nodeVendors = node.gpus.map(g => g.vendor);
    if (!req.requiredPlatforms.some(p => nodeVendors.includes(p))) {
      return "wrong_platform";
    }
  }

  if (node.free < req.capacityGb) return "insufficient_capacity";

  return null;
}

/** Driver features implied by a model's type rather than declared on it. */
export function requiredFeaturesForEngine(engine: string, type: string | undefined): string[] {
  return engine === "vllm" && type === "transcription" ? ["audio"] : [];
}

/** A model as seen by cluster-wide deployability checks. */
export type ClusterModel = {
  weight: number;
  minKvCache: number;
  type?: string;
  providers: Record<string, string | undefined>;
  providerMinVersions?: Record<string, string>;
  providerPlatforms?: Record<string, string[]>;
};

export function modelRequirementsForDriver(model: ClusterModel, driver: string): ModelNodeRequirements {
  return {
    driver,
    capacityGb: model.weight + model.minKvCache,
    minVersion: model.providerMinVersions?.[driver],
    requiredPlatforms: model.providerPlatforms?.[driver] ?? [],
    requiredFeatures: requiredFeaturesForEngine(driver, model.type),
  };
}

/** How far through checkNodeCompatibility's ordered checks a node got before failing. */
const REASON_PROGRESS: Record<IncompatibilityReason, number> = {
  missing_driver: 0,
  version_unknown: 1,
  version_too_old: 1,
  missing_feature: 2,
  wrong_platform: 3,
  insufficient_capacity: 4,
};

/**
 * Returns null if any node can serve the model via any of its providers, otherwise
 * the reason from the node/driver pair that came closest to working.
 *
 * Reporting the closest pair matters: a cluster where one node is merely full and
 * another lacks the driver is a capacity problem, not a driver problem.
 */
export function explainClusterIncompatibility(
  nodes: NodeCapability[],
  model: ClusterModel,
): IncompatibilityReason | null {
  const drivers = Object.keys(model.providers).filter(d => model.providers[d] !== undefined);

  let closest: IncompatibilityReason = "missing_driver";
  for (const node of nodes) {
    for (const driver of drivers) {
      const reason = checkNodeCompatibility(node, modelRequirementsForDriver(model, driver));
      if (reason === null) return null;
      if (REASON_PROGRESS[reason] > REASON_PROGRESS[closest]) closest = reason;
    }
  }
  return closest;
}

/**
 * Returns true if at least one node can serve the model. The engine is part of
 * the model's identity, so unlike the v1 form there is no set of drivers to try.
 */
export function isDeployableOnCluster(
  nodes: NodeCapability[],
  model: Pick<Model, "sizing" | "type" | "engine" | "minEngineVersion" | "platforms">,
): boolean {
  const req: ModelNodeRequirements = {
    driver: model.engine,
    capacityGb: mibToGb(model.sizing.weightMib + model.sizing.minKvCacheMib),
    minVersion: model.minEngineVersion,
    requiredPlatforms: model.platforms ?? [],
    requiredFeatures: requiredFeaturesForEngine(model.engine, model.type),
  };
  return nodes.some(node => checkNodeCompatibility(node, req) === null);
}

/**
 * DEPRECATED v1 form: a single entry could claim several engines, so every
 * provider has to be tried. Removed before 1.0.0 with the format.
 */
export function isLegacyModelDeployableOnCluster(
  nodes: NodeCapability[],
  model: Pick<LegacyModel, "weight" | "minKvCache" | "type" | "providers" | "providerMinVersions" | "providerPlatforms">,
): boolean {
  return explainClusterIncompatibility(nodes, model) === null;
}
