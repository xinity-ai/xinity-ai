import { sql, organizationT, aiApplicationT, modelDeploymentT } from "common-db";
import { getDB } from "$lib/server/db";

export async function findOrgName(organizationId: string): Promise<string | null> {
  const [row] = await getDB()
    .select({ name: organizationT.name })
    .from(organizationT)
    .where(sql`${organizationT.id} = ${organizationId}`)
    .limit(1);
  return row?.name ?? null;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Applications and deployments reference the organization ON DELETE restrict,
 * and a soft-deleted row still holds its reference. Returns why the delete
 * would be rejected, or null when nothing blocks it.
 */
export async function findOrgDeleteBlockers(organizationId: string): Promise<string | null> {
  const db = getDB();
  const [[applications], [deployments]] = await Promise.all([
    db.select({
      total: sql<number>`cast(count(*) as int)`,
      discarded: sql<number>`cast(count(${aiApplicationT.deletedAt}) as int)`,
    }).from(aiApplicationT).where(sql`${aiApplicationT.organizationId} = ${organizationId}`),
    db.select({
      total: sql<number>`cast(count(*) as int)`,
      discarded: sql<number>`cast(count(${modelDeploymentT.deletedAt}) as int)`,
    }).from(modelDeploymentT).where(sql`${modelDeploymentT.organizationId} = ${organizationId}`),
  ]);

  const blockers: string[] = [];
  if (applications && applications.total > 0) {
    blockers.push(countLabel(applications.total, "application"));
  }
  if (deployments && deployments.total > 0) {
    blockers.push(countLabel(deployments.total, "model deployment"));
  }
  if (blockers.length === 0) {
    return null;
  }

  const discarded = (applications?.discarded ?? 0) + (deployments?.discarded ?? 0);
  const retained = discarded > 0
    ? ` ${discarded} of them ${discarded === 1 ? "is" : "are"} already deleted but still retained.`
    : "";
  return `This organization still has ${blockers.join(" and ")},`
    + ` which must be removed before the organization can be deleted.${retained}`;
}
