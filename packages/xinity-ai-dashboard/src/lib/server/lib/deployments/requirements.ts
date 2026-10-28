import { calcCanaryProgress, type DeploymentLegacy, type DeploymentManaged } from "common-db";
import type { DeploymentSettings } from "common-env";
import type { Provider } from "common-env/model-catalog";
import { ownedByLegacy, ownedByManaged, requirementKey, type InstallationOwnership } from "./placement";

export type ModelRequirement = InstallationOwnership & { specifier: string; replicas: number; kvCacheSize: number | null; preferredDriver: Provider | null; settings: DeploymentSettings };
export type ModelRequirementTable = Record<string, ModelRequirement>;

export type DeploymentPlan = Pick<
  DeploymentLegacy,
  "id" | "specifier" | "earlySpecifier" | "replicas" | "kvCacheSize" | "earlyKvCacheSize" | "preferredDriver" | "settings" | "progress" | "canaryProgressFrom" | "canaryProgressUntil"
>;

export type ManagedPlan = Pick<DeploymentManaged, "id" | "specifier" | "replicas" | "kvCacheSize" | "preferredDriver" | "settings">;

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
    return [
      side(specifier, Math.ceil(replicas * (progress / 100)), deployment.kvCacheSize),
      side(earlySpecifier, Math.ceil(replicas * ((100 - progress) / 100)), deployment.earlyKvCacheSize),
    ];
  }));
}

export function requirementsForManaged(rows: ManagedPlan[]): ModelRequirementTable {
  return tableOf(rows.map(({ id, specifier, replicas, kvCacheSize, preferredDriver, settings }) =>
    ({ ...ownedByManaged(id), specifier, replicas, kvCacheSize, preferredDriver, settings })));
}
