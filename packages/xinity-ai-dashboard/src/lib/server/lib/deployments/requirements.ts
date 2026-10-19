import { calcCanaryProgress, type ModelDeployment } from "common-db";
import type { DeploymentSettings } from "common-env";
import type { Provider } from "common-env/model-catalog";
import { requirementKey } from "./placement";

export type ModelRequirement = { deploymentId: string; specifier: string; replicas: number; kvCacheSize: number | null; preferredDriver: Provider | null; settings: DeploymentSettings };
export type ModelRequirementTable = Record<string, ModelRequirement>;

export type DeploymentPlan = Pick<
  ModelDeployment,
  "id" | "specifier" | "earlySpecifier" | "replicas" | "kvCacheSize" | "earlyKvCacheSize" | "preferredDriver" | "settings" | "progress" | "canaryProgressFrom" | "canaryProgressUntil"
>;

// One requirement per deployment and model side, since an installation serves exactly one deployment
export function requirementsForDeployments(deployments: DeploymentPlan[]): ModelRequirementTable {
  const requirements = deployments.flatMap((deployment): ModelRequirement[] => {
    const progress = calcCanaryProgress(deployment);
    const { id: deploymentId, specifier, earlySpecifier, replicas, preferredDriver, settings } = deployment;
    const side = (sideSpecifier: string, sideReplicas: number, kvCacheSize: number | null): ModelRequirement =>
      ({ deploymentId, specifier: sideSpecifier, replicas: sideReplicas, kvCacheSize, preferredDriver, settings });
    if (progress === 100 || !earlySpecifier || earlySpecifier === specifier) {
      return [side(specifier, replicas, deployment.kvCacheSize)];
    }
    return [
      side(specifier, Math.ceil(replicas * (progress / 100)), deployment.kvCacheSize),
      side(earlySpecifier, Math.ceil(replicas * ((100 - progress) / 100)), deployment.earlyKvCacheSize),
    ];
  });
  return Object.fromEntries(requirements.map((requirement) => [requirementKey(requirement), requirement]));
}
