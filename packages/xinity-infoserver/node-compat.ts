/**
 * Consolidated model-node compatibility checking.
 * Single source of truth for "can this node serve this model?"
 * Pure functions with no DB or IO dependencies.
 */
import { satisfiesMinVersion } from "./semver";

/** Per-GPU info as detected by the daemon and persisted on aiNodeT. */
export type GpuInfo = {
  vendor: string;
  name: string;
  vramMb: number;
};

/** Minimal representation of a node's capabilities. */
export type NodeCapability = {
  free: number;
  drivers: string[];
  driverVersions: Record<string, string>;
  gpus: GpuInfo[];
};

/** What a model needs from a node, resolved from model metadata for a specific driver. */
export type ModelNodeRequirements = {
  driver: string;
  capacityGb: number;
  minVersion?: string;
  requiredPlatforms: string[]; // empty = any platform
};

export type IncompatibilityReason =
  | "missing_driver"
  | "version_too_old"
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
 * Fail-open for driverVersions: nodes that haven't reported a version
 * are not excluded (may be mid-upgrade).
 * Fail-closed for gpus: if a model requires specific GPU platforms,
 * nodes with no GPUs or wrong vendors are excluded.
 */
export function checkNodeCompatibility(
  node: NodeCapability,
  req: ModelNodeRequirements,
): IncompatibilityReason | null {
  if (!node.drivers.includes(req.driver)) return "missing_driver";

  if (req.minVersion) {
    const nodeVersion = node.driverVersions[req.driver];
    if (nodeVersion && !satisfiesMinVersion(nodeVersion, req.minVersion)) {
      return "version_too_old";
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

/**
 * Returns true if at least one node can serve the model via any of its providers.
 * Used by client-side model selector to determine deployability.
 */
export function isDeployableOnCluster(
  nodes: NodeCapability[],
  model: {
    weight: number;
    minKvCache: number;
    providers: Record<string, string | undefined>;
    providerMinVersions?: Record<string, string>;
    providerPlatforms?: Record<string, string[]>;
  },
): boolean {
  const needed = model.weight + model.minKvCache;
  const drivers = Object.keys(model.providers).filter(d => model.providers[d] !== undefined);

  return nodes.some(node =>
    drivers.some(driver => {
      const req: ModelNodeRequirements = {
        driver,
        capacityGb: needed,
        minVersion: model.providerMinVersions?.[driver],
        requiredPlatforms: model.providerPlatforms?.[driver] ?? [],
      };
      return checkNodeCompatibility(node, req) === null;
    }),
  );
}
