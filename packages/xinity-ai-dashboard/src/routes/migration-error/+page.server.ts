import { getMigrationState } from "$lib/server/migration-check";
import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const state = getMigrationState();

  if (!state || state.status === "ok") {
    redirect(302, "/");
  }

  return { migrationState: state };
};
