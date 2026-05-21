import { eq, organizationT } from "common-db";
import { getDB } from "$lib/server/db";

export async function findOrgName(organizationId: string): Promise<string | null> {
  const [row] = await getDB()
    .select({ name: organizationT.name })
    .from(organizationT)
    .where(eq(organizationT.id, organizationId))
    .limit(1);
  return row?.name ?? null;
}
