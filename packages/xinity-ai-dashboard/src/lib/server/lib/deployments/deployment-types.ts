import { deploymentT, sql, type Deployment } from "common-db";
import { DEPLOYMENT_TYPES, type DeploymentType } from "common-env";
import type { DeploymentOutput, DeploymentUpdate } from "$lib/orpc/dtos/model.dto";
import { getDB } from "$lib/server/db";
import { canaryDeployment } from "./canary-deployment";
import { legacyDeployment } from "./legacy-deployment";
import { managedDeployment } from "./managed-deployment";
import type { ModelRequirementTable } from "./requirements";

export type Transaction = Parameters<Parameters<ReturnType<typeof getDB>["transaction"]>[0]>[0];

/** What has to fit on the cluster. `changing` lists the rows whose installations the change may move or remove. */
export type CapacityNeed = { requirements: ModelRequirementTable; changing?: string[] };

export type UpdateReview =
  | { rejected: string }
  | { mustFit?: CapacityNeed };

export type DashboardDeploymentType = {
  read: (entries: Deployment[]) => Promise<DeploymentOutput[]>;
  withStatus: (entries: Deployment[]) => Promise<DeploymentOutput[]>;
  /** What the entries need placed on nodes while they are enabled. */
  requirements: (entries: Deployment[]) => Promise<ModelRequirementTable>;
  /** Why an update cannot be made, or what has to fit for it to be made. Writes nothing. */
  reviewUpdate: (entry: Deployment, input: DeploymentUpdate) => Promise<UpdateReview>;
  update: (tx: Transaction, entry: Deployment, input: DeploymentUpdate) => Promise<void>;
};

export const DASHBOARD_DEPLOYMENT_TYPES: Record<DeploymentType, DashboardDeploymentType> = {
  legacy: legacyDeployment,
  managed: managedDeployment,
  canary: canaryDeployment,
};

export async function byType<R>(entries: Deployment[], run: (type: DashboardDeploymentType, entries: Deployment[]) => Promise<R>): Promise<R[]> {
  return Promise.all(DEPLOYMENT_TYPES.flatMap((type) => {
    const ofType = entries.filter((entry) => entry.type === type);
    return ofType.length > 0 ? [run(DASHBOARD_DEPLOYMENT_TYPES[type], ofType)] : [];
  }));
}

export function enabledDeployments(): Promise<Deployment[]> {
  return getDB().select().from(deploymentT).where(sql`${deploymentT.enabled} AND ${deploymentT.deletedAt} IS NULL`);
}
