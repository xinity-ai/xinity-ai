import { calcCanaryProgress, type ModelDeployment } from "common-db";
import type { DeploymentSettings } from "common-env";
import type { Provider } from "common-env/model-catalog";
import { requirementKey } from "./placement";

export type ModelRequirement = { deploymentId: string; specifier: string; replicas: number; kvCacheSize: number | null; preferredDriver: Provider | null; settings: DeploymentSettings };
export type ModelRequirementTable = Record<string, ModelRequirement>;

// One requirement per deployment and model side, since an installation serves exactly one deployment
export function requirementsForDeployments(deployments: ModelDeployment[]): ModelRequirementTable {
  const requirements = deployments.flatMap((deployment): ModelRequirement[] => {
    const progress = calcCanaryProgress(deployment);
    const earlySpecifier = deployment.earlySpecifier;
    const driver = deployment.preferredDriver;
    const isNotCanary = progress === 100 || !earlySpecifier || earlySpecifier === deployment.specifier;
    if (isNotCanary) {
      return [requirementFor(deployment.id, deployment.specifier, deployment.replicas, deployment.kvCacheSize, driver, deployment.settings)];
    }
    return [
      requirementFor(deployment.id, deployment.specifier, Math.ceil(deployment.replicas * (progress / 100)), deployment.kvCacheSize, driver, deployment.settings),
      requirementFor(deployment.id, earlySpecifier, Math.ceil(deployment.replicas * ((100 - progress) / 100)), deployment.earlyKvCacheSize, driver, deployment.settings),
    ];
  });
  return Object.fromEntries(requirements.map((requirement) => [requirementKey(requirement), requirement]));
}

function requirementFor(
  deploymentId: string,
  specifier: string,
  replicas: number,
  kvCacheSize: number | null,
  preferredDriver: Provider | null,
  settings: DeploymentSettings,
): ModelRequirement {
  return { deploymentId, specifier, replicas, kvCacheSize, preferredDriver, settings };
}
