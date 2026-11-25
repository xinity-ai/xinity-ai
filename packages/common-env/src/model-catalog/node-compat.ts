/**
 * Consolidated model-node compatibility checking.
 * Single source of truth for "can this node serve this model?"
 * Pure functions with no DB or IO dependencies.
 */
import { matchesVersionRange, satisfiesMinVersion } from "./semver";
import type { Model } from "./definitions/model-definition";
import { isKnownModelType, type ModelType } from "./definitions/model-primitives";
import { z } from "zod";
import type { GpuInfo } from "../tether-protocol";

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

type CheckOptions = { requireKnownVersion?: boolean };

function stage<const R extends string>(
  reasons: readonly R[],
  check: (node: NodeCapability, req: ModelNodeRequirements, options: CheckOptions) => R | null,
) {
  return { reasons, check };
}

/**
 * The checks in the order they run, which is also how far a failing node got.
 * Capacity comes last so callers can separate "structurally incompatible" from
 * "just no capacity" for greedy allocation loops. A missing feature comes before
 * the version, since upgrading the driver does not help when its build lacks the feature.
 */
const COMPATIBILITY_STAGES = [
  stage(["missing_driver"], (node, req) => (req.driver in node.driverVersions ? null : "missing_driver")),
  stage(["missing_feature"], (node, req) => {
    const nodeFeatures = node.driverFeatures?.[req.driver] ?? [];
    return (req.requiredFeatures ?? []).every(f => nodeFeatures.includes(f)) ? null : "missing_feature";
  }),
  stage(["version_unknown", "version_too_old", "version_blocked"], (node, req, options) => {
    const nodeVersion = node.driverVersions[req.driver];
    if (!nodeVersion) {
      const constrainsVersion = req.minVersion !== undefined || (req.blockedVersions?.length ?? 0) > 0;
      // TODO v1.0.0 default requireKnownVersion to true
      return constrainsVersion && options.requireKnownVersion ? "version_unknown" : null;
    }
    if (req.minVersion && !satisfiesMinVersion(nodeVersion, req.minVersion)) {
      return "version_too_old";
    }
    if (req.blockedVersions?.some(blocked => matchesVersionRange(nodeVersion, blocked.range))) {
      return "version_blocked";
    }
    return null;
  }),
  // Fail-closed: a model that requires GPU platforms excludes nodes with no GPUs or other vendors.
  stage(["wrong_platform"], (node, req) => {
    if (req.requiredPlatforms.length === 0) {
      return null;
    }
    const nodeVendors = node.gpus.map(g => g.vendor);
    return req.requiredPlatforms.some(p => nodeVendors.includes(p)) ? null : "wrong_platform";
  }),
  stage(["insufficient_capacity"], (node, req) => (node.free < req.capacityGb ? "insufficient_capacity" : null)),
];

export type IncompatibilityReason = (typeof COMPATIBILITY_STAGES)[number]["reasons"][number];

const REASON_STAGE = Object.fromEntries(
  COMPATIBILITY_STAGES.flatMap((s, index) => s.reasons.map(reason => [reason, index])),
) as Record<IncompatibilityReason, number>;

export const IncompatibilityReasonEnum = z.enum(
  COMPATIBILITY_STAGES.flatMap(s => s.reasons) as [IncompatibilityReason, ...IncompatibilityReason[]],
);

/** Checks whether a single node can serve a model. Returns null if compatible, or the first failing reason. */
export function checkNodeCompatibility(
  node: NodeCapability,
  req: ModelNodeRequirements,
  options: CheckOptions = {},
): IncompatibilityReason | null {
  for (const { check } of COMPATIBILITY_STAGES) {
    const reason = check(node, req, options);
    if (reason) {
      return reason;
    }
  }
  return null;
}

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
    if (REASON_STAGE[reason] > REASON_STAGE[closest]) {
      closest = reason;
    }
  }
  return closest;
}

const VLLM_FEATURES_BY_TYPE: Record<ModelType, string[]> = {
  chat: [],
  embedding: [],
  rerank: [],
  transcription: ["audio"],
  image: ["vllm-omni"],
};

/** Driver features implied by a model's type rather than declared on it. */
export function requiredFeaturesForEngine(engine: string, type: string | undefined): string[] {
  return engine === "vllm" && isKnownModelType(type) ? VLLM_FEATURES_BY_TYPE[type] : [];
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
