import { getDB } from "$lib/server/db";
import { aiApiKeyT, sql } from "common-db";
import type { PageServerLoad } from "./$types";


export const load: PageServerLoad = async ({ parent }) => {
  const { user, session } = await parent();

  if (!session.activeOrganizationId) {
    return {
      apiKeys: [],
    }
  }

  const apiKeys = await getDB()
    .select()
    .from(aiApiKeyT)
    .orderBy(aiApiKeyT.updatedAt)
    .where(sql`${aiApiKeyT.organizationId} = ${session.activeOrganizationId}`);

  return {
    apiKeys,
  }
};