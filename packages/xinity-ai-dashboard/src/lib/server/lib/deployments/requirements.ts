import { calcCanaryProgress, type DeploymentCanary, type DeploymentLegacy, type DeploymentManaged } from "common-db";
import type { DeploymentSettings } from "common-env";
import type { Provider } from "common-env/model-catalog";
import { MIN_CANARY_REPLICAS } from "$lib/orpc/dtos/model.dto";
import { ownedByLegacy, ownedByManaged, requirementKey, type InstallationOwnership } from "./placement";

export type ModelRequirement = InstallationOwnership & { specifier: string; replicas: number; kvCacheSize: number | null; preferredDriver: Provider | null; settings: DeploymentSettings };
export type ModelRequirementTable = Record<string, ModelRequirement>;

export type DeploymentPlan = Pick<
  DeploymentLegacy,
  "id" | "specifier" | "earlySpecifier" | "replicas" | "kvCacheSize" | "earlyKvCacheSize" | "preferredDriver" | "settings" | "progress" | "canaryProgressFrom" | "canaryProgressUntil"
>;

export type ManagedPlan = Pick<DeploymentManaged, "id" | "specifier" | "replicas" | "kvCacheSize" | "preferredDriver" | "settings">;

export type CanaryMemberPlan = Omit<ManagedPlan, "replicas">;

export type CanaryPlan = Pick<DeploymentCanary, "replicas" | "progress"> & { from: CanaryMemberPlan; to: CanaryMemberPlan };

const tableOf = (requirements: ModelRequirement[]): ModelRequirementTable =>
  Object.fromEntries(requirements.map((requirement) => [requirementKey(requirement), requirement]));

// One requirement per deployment and model side, since an installation serves exactly one deployment
export function requirementsForDeployments(deployments: DeploymentPlan[]): ModelRequirementTable {
  return tableOf(deployments.flatMap((deployment): ModelRequirement[] => {
    const progress = calcCanaryProgress(deployment);
    const { id, specifier, earlySpecifier, replicas, preferredDriver, settings } = deployment;
    const side = (sideSpecifier: string, sideReplicas: number, kvCacheSize: number | null): ModelRequirement =>
      ({ ...ownedByLegacy(id), specifier: sideSpecifier, replicas: sideReplicas, kvCacheSize, preferredDriver, settings });
    if (progress === 100 || !earlySpecifier || earlySpecifier === specifier) {
      return [side(specifier, replicas, deployment.kvCacheSize)];
    }
    const split = canaryReplicas(replicas, progress);
    return [side(specifier, split.to, deployment.kvCacheSize), side(earlySpecifier, split.from, deployment.earlyKvCacheSize)];
  }));
}

function managedRequirement({ id, specifier, kvCacheSize, preferredDriver, settings }: CanaryMemberPlan, replicas: number): ModelRequirement {
  return { ...ownedByManaged(id), specifier, replicas, kvCacheSize, preferredDriver, settings };
}

export function requirementsForManaged(rows: ManagedPlan[]): ModelRequirementTable {
  return tableOf(rows.map((row) => managedRequirement(row, row.replicas)));
}

export function canaryReplicas(replicas: number, progress: number): { from: number; to: number } {
  const budget = Math.max(MIN_CANARY_REPLICAS, replicas);
  if (progress <= 0) {
    return { from: budget, to: 0 };
  }
  if (progress >= 100) {
    return { from: 0, to: budget };
  }
  const from = Math.min(budget - 1, Math.max(1, Math.round(budget * ((100 - progress) / 100))));
  return { from, to: budget - from };
}

export function requirementsForCanaries(canaries: CanaryPlan[]): ModelRequirementTable {
  return tableOf(canaries.flatMap((canary) => {
    const split = canaryReplicas(canary.replicas, canary.progress);
    return [managedRequirement(canary.from, split.from), managedRequirement(canary.to, split.to)];
  }).filter(({ replicas }) => replicas > 0));
}
