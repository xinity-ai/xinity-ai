import type { LayoutServerLoad } from "./$types";
import { isInstanceAdmin } from "$lib/server/serverenv";
import { redirect } from "@sveltejs/kit";

export const load: LayoutServerLoad = async ({ parent }) => {
  const { user } = await parent();

  if (!isInstanceAdmin(user.email)) {
    redirect(302, "/");
  }

  return {};
};
