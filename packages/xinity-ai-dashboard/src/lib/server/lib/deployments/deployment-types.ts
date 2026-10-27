import { deploymentT, sql, type Deployment } from "common-db";
import { DEPLOYMENT_TYPES, type DeploymentType } from "common-env";
import type { DeploymentOutput, DeploymentUpdate } from "$lib/orpc/dtos/model.dto";
import { getDB } from "$lib/server/db";
import type { DeploymentPhaseRow } from "$lib/server/notifications/scheduler";
import { legacyDeployment } from "./legacy-deployment";
import type { ModelRequirementTable } from "./requirements";

export type Transaction = Parameters<Parameters<ReturnType<typeof getDB>["transaction"]>[0]>[0];

export type UpdateReview =
  | { rejected: string }
  | { mustFit?: { requirements: ModelRequirementTable; replacing?: string[] } };

export type DashboardDeploymentType = {
  read: (entries: Deployment[]) => Promise<DeploymentOutput[]>;
  withStatus: (entries: Deployment[]) => Promise<DeploymentOutput[]>;
  /** What the entries need placed on nodes while they are enabled. */
  requirements: (entries: Deployment[]) => Promise<ModelRequirementTable>;
  phases: (entries: Deployment[]) => Promise<DeploymentPhaseRow[]>;
  /** Why an update cannot be made, or what has to fit for it to be made. Writes nothing. */
  reviewUpdate: (entry: Deployment, input: DeploymentUpdate) => Promise<UpdateReview>;
  update: (tx: Transaction, entry: Deployment, input: DeploymentUpdate) => Promise<void>;
};

function notServedYet(type: DeploymentType): DashboardDeploymentType {
  const refuse = (): never => {
    throw new Error(`The dashboard does not serve ${type} deployments yet`);
  };
  return { read: refuse, withStatus: refuse, requirements: refuse, phases: refuse, reviewUpdate: refuse, update: refuse };
}

export const DASHBOARD_DEPLOYMENT_TYPES: Record<DeploymentType, DashboardDeploymentType> = {
  legacy: legacyDeployment,
  managed: notServedYet("managed"),
  canary: notServedYet("canary"),
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
