import { loadOrgModels, type OrgModel } from "$lib/server/org-models";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, parent }) => {
  const { activeOrganizationId } = await parent();
  if (!activeOrganizationId) return { models: [] as OrgModel[] };

  const models = await loadOrgModels(locals);
  return { models: models.filter(m => m.type === "chat" && m.tools) };
};
