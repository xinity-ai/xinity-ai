import { inArray, sql, organizationT, aiApplicationT, deploymentT, deploymentLegacyT, inferenceCallT, apiResponseT } from "common-db";
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
 * Applications and deployments reference the organization ON DELETE restrict.
 * Returns why the delete would be rejected, or null when nothing blocks it.
 * Soft-deleted rows are not blockers, see purgeSoftDeletedOrgDependents.
 */
export async function findOrgDeleteBlockers(organizationId: string): Promise<string | null> {
  const db = getDB();
  const total = { count: sql<number>`cast(count(*) as int)` };
  const [[applications], [deployments]] = await Promise.all([
    db.select(total).from(aiApplicationT).where(sql`
      ${aiApplicationT.organizationId} = ${organizationId} AND ${aiApplicationT.deletedAt} IS NULL
    `),
    db.select(total).from(deploymentT).where(sql`
      ${deploymentT.organizationId} = ${organizationId} AND ${deploymentT.deletedAt} IS NULL
    `),
  ]);

  const blockers: string[] = [];
  if (applications && applications.count > 0) {
    blockers.push(countLabel(applications.count, "application"));
  }
  if (deployments && deployments.count > 0) {
    blockers.push(countLabel(deployments.count, "model deployment"));
  }
  if (blockers.length === 0) {
    return null;
  }
  return `This organization still has ${blockers.join(" and ")},`
    + " which must be removed before the organization can be deleted.";
}

/**
 * Nothing in the product can clear a soft-deleted row, so one would otherwise
 * hold its ON DELETE restrict reference forever. Callers that reference these
 * rows (api keys, calls, usage) do so ON DELETE set null.
 */
export async function purgeSoftDeletedOrgDependents(organizationId: string): Promise<number> {
  return await getDB().transaction(async (tx) => {
    const applications = await tx
      .delete(aiApplicationT)
      .where(sql`
        ${aiApplicationT.organizationId} = ${organizationId} AND ${aiApplicationT.deletedAt} IS NOT NULL
      `)
      .returning({ id: aiApplicationT.id });
    const deployments = await tx
      .delete(deploymentT)
      .where(sql`
        ${deploymentT.organizationId} = ${organizationId} AND ${deploymentT.deletedAt} IS NOT NULL
      `)
      .returning({ legacyId: deploymentT.legacyId });
    const legacyIds = deployments.flatMap(({ legacyId }) => (legacyId ? [legacyId] : []));
    if (legacyIds.length > 0) {
      await tx.delete(deploymentLegacyT).where(inArray(deploymentLegacyT.id, legacyIds));
    }
    return applications.length + deployments.length;
  });
}

export async function deleteOrgCallLogs(organizationId: string): Promise<void> {
  await getDB().transaction(async (tx) => {
    await tx.delete(inferenceCallT).where(sql`${inferenceCallT.organizationId} = ${organizationId}`);
    await tx.delete(apiResponseT).where(sql`${apiResponseT.organizationId} = ${organizationId}`);
  });
}
