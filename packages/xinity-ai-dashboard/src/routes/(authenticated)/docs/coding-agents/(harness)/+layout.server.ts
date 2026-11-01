import { loadOrgModels } from "$lib/server/lib/models/org-models";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, parent }) => {
  const { activeOrganizationId } = await parent();
  if (!activeOrganizationId) {
    return { models: [] };
  }

  const models = await loadOrgModels(locals);
  return { models: models.filter(m => m.type === "chat" && m.tools) };
};
