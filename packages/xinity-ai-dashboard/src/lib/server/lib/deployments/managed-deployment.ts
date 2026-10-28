import { deploymentManagedT, deploymentT, inArray, managedOfDeployment, sql, type Deployment, type DeploymentManaged } from "common-db";
import type { DeploymentOutput, ManagedDeploymentInput } from "$lib/orpc/dtos/model.dto";
import { getDB } from "$lib/server/db";
import { markMissingFromCatalog, phasesOf, withInstallationStatus } from "./deployment-reads";
import type { DashboardDeploymentType, Transaction } from "./deployment-types";
import { requirementsForManaged } from "./requirements";

const outputOf = (entry: Deployment, managed: DeploymentManaged): DeploymentOutput => ({ ...entry, type: "managed", managed });

function withManagedRows(entries: Deployment[]) {
  return getDB().select().from(deploymentT)
    .innerJoin(deploymentManagedT, managedOfDeployment)
    .where(inArray(deploymentT.id, entries.map(({ id }) => id)));
}

async function read(entries: Deployment[]): Promise<DeploymentOutput[]> {
  const rows = await withManagedRows(entries);
  return rows.map(({ deployment, deployment_managed }) => outputOf(deployment, deployment_managed));
}

export async function createManaged(tx: Transaction, input: ManagedDeploymentInput): Promise<string> {
  const [managed] = await tx.insert(deploymentManagedT).values(input).returning({ id: deploymentManagedT.id });
  if (!managed) {
    throw new Error("Insert into deploymentManagedT returned no row");
  }
  return managed.id;
}

const RESTRICTED_WHILE_ENABLED = ["specifier", "kvCacheSize", "preferredDriver"] as const;

export const managedDeployment: DashboardDeploymentType = {
  read,

  async withStatus(entries) {
    const deployments = await withInstallationStatus(await read(entries));
    await markMissingFromCatalog(deployments, (deployment) => deployment.type === "managed" ? [deployment.managed.specifier] : []);
    return deployments;
  },

  async requirements(entries) {
    const rows = await withManagedRows(entries);
    return requirementsForManaged(rows.map(({ deployment_managed }) => deployment_managed));
  },

  async phases(entries) {
    const rows = await withManagedRows(entries);
    return phasesOf(entries, new Map(rows.map(({ deployment, deployment_managed }) => [deployment.id, deployment_managed.replicas])));
  },

  async reviewUpdate(entry, input) {
    const [row] = await withManagedRows([entry]);
    if (!row) {
      return {};
    }
    const managed = row.deployment_managed;
    const patch = input.managed ?? {};

    const staysEnabled = entry.enabled && input.enabled !== false;
    if (staysEnabled) {
      const changed = RESTRICTED_WHILE_ENABLED.filter((field) => patch[field] !== undefined && patch[field] !== managed[field]);
      if (changed.length > 0) {
        return { rejected: `Cannot change ${changed.join(", ")} while the deployment is enabled. Disable it first.` };
      }
    }

    const reenabling = input.enabled && !entry.enabled;
    const scalingUp = staysEnabled && patch.replicas !== undefined && patch.replicas > managed.replicas;
    if (!reenabling && !scalingUp) {
      return {};
    }
    return { mustFit: { requirements: requirementsForManaged([{ ...managed, ...patch }]), replacing: scalingUp ? [managed.id] : undefined } };
  },

  async update(tx, entry, input) {
    const patch = input.managed;
    if (!entry.managedId || !patch || Object.values(patch).every((value) => value === undefined)) {
      return;
    }
    await tx.update(deploymentManagedT).set(patch).where(sql`${deploymentManagedT.id} = ${entry.managedId}`);
  },
};
