import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";

export const load: PageServerLoad = async ({ parent }) => {
  const { canCreateOrganization } = await parent();
  if (!canCreateOrganization) {
    redirect(302, "/organizations");
  }
};
