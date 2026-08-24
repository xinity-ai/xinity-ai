/**
 * Consolidated model-node compatibility checking.
 * Single source of truth for "can this node serve this model?"
 * Pure functions with no DB or IO dependencies.
 */
import { matchesVersionRange, satisfiesMinVersion } from "./semver";
import type { LegacyModel, Model } from "./definitions/model-definition";

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

export type BlockedVersion = { range: string; reason: string };

/** What a model needs from a node, resolved from model metadata for a specific driver. */
export type ModelNodeRequirements = {
  driver: string;
  capacityGb: number;
  minVersion?: string;
  blockedVersions?: BlockedVersion[];
  requiredPlatforms: string[];
  requiredFeatures?: string[];
};

export type IncompatibilityReason =
  | "missing_driver"
  | "version_too_old"
  | "version_unknown"
  | "version_blocked"
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

  const nodeVersion = node.driverVersions[req.driver];
  const constrainsVersion = req.minVersion !== undefined || (req.blockedVersions?.length ?? 0) > 0;

  if (constrainsVersion && !nodeVersion) {
    if (requireKnownVersion) return "version_unknown";
  } else if (nodeVersion) {
    if (req.minVersion && !satisfiesMinVersion(nodeVersion, req.minVersion)) {
      return "version_too_old";
    }
    if (req.blockedVersions?.some(blocked => matchesVersionRange(nodeVersion, blocked.range))) {
      return "version_blocked";
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
  version_blocked: 1,
  missing_feature: 2,
  wrong_platform: 3,
  insufficient_capacity: 4,
};

/**
 * Collapses the outcomes of several candidates into one: null if any candidate worked,
 * otherwise the reason from the one that came closest.
 *
 * Reporting the closest matters: a cluster where one node is merely full and another
 * lacks the driver is a capacity problem, not a driver problem. The same holds across
 * the variants of one model, where a quantization that fits beats one that does not.
 */
export function nearestIncompatibility(
  reasons: Iterable<IncompatibilityReason | null>,
): IncompatibilityReason | null {
  let closest: IncompatibilityReason = "missing_driver";
  for (const reason of reasons) {
    if (reason === null) {
      return null;
    }
    if (REASON_PROGRESS[reason] > REASON_PROGRESS[closest]) {
      closest = reason;
    }
  }
  return closest;
}

/** Returns null if any node can serve the model via any of its providers. */
export function explainLegacyClusterIncompatibility(
  nodes: NodeCapability[],
  model: ClusterModel,
): IncompatibilityReason | null {
  const drivers = Object.keys(model.providers).filter(d => model.providers[d] !== undefined);

  return nearestIncompatibility(
    nodes.flatMap(node =>
      drivers.map(driver => checkNodeCompatibility(node, modelRequirementsForDriver(model, driver))),
    ),
  );
}

/** Everything a cluster-wide deployability check reads off a model. */
export type DeployableModel = Pick<Model, "sizing" | "type" | "engine" | "engineVersions" | "platforms">;

/** The rules that keep a model off a node. Other effects are for other consumers to read. */
export function blockedVersionRules(model: DeployableModel): BlockedVersion[] {
  return (model.engineVersions?.rules ?? []).filter(rule => rule.effect === "blocked");
}

export function modelRequirements(model: DeployableModel): ModelNodeRequirements {
  return {
    driver: model.engine,
    capacityGb: model.sizing.weightGb + model.sizing.minKvCacheGb,
    minVersion: model.engineVersions?.min,
    blockedVersions: blockedVersionRules(model),
    requiredPlatforms: model.platforms ?? [],
    requiredFeatures: requiredFeaturesForEngine(model.engine, model.type),
  };
}

/** Returns null if any node can serve the model. */
export function explainClusterIncompatibility(
  nodes: NodeCapability[],
  model: DeployableModel,
): IncompatibilityReason | null {
  const req = modelRequirements(model);
  return nearestIncompatibility(nodes.map(node => checkNodeCompatibility(node, req)));
}

export function isDeployableOnCluster(nodes: NodeCapability[], model: DeployableModel): boolean {
  return explainClusterIncompatibility(nodes, model) === null;
}

/** Why the releases this cluster is actually running are excluded. Empty when none are. */
export function blockedVersionNotes(nodes: NodeCapability[], model: DeployableModel): string[] {
  const running = nodes
    .map(node => node.driverVersions[model.engine])
    .filter((version): version is string => !!version);
  return blockedVersionRules(model)
    .filter(blocked => running.some(version => matchesVersionRange(version, blocked.range)))
    .map(blocked => blocked.reason);
}

/**
 * DEPRECATED v1 form: a single entry could claim several engines, so every
 * provider has to be tried. Removed before 1.0.0 with the format.
 */
export function isLegacyModelDeployableOnCluster(
  nodes: NodeCapability[],
  model: Pick<LegacyModel, "weight" | "minKvCache" | "type" | "providers" | "providerMinVersions" | "providerPlatforms">,
): boolean {
  return explainLegacyClusterIncompatibility(nodes, model) === null;
}
