import type { PageServerLoad } from "./$types";
import { buildFleetOverview, buildFleetHistory } from "$lib/server/orpc/procedures/fleet.procedure";
import { isInstanceAdmin } from "$lib/server/serverenv";

export const load: PageServerLoad = async ({ parent }) => {
  const { user } = await parent();

  if (!isInstanceAdmin(user.email)) {
    return { authorized: false as const };
  }

  const [overview, history] = await Promise.all([
    buildFleetOverview(24),
    buildFleetHistory(24),
  ]);
  return { authorized: true as const, overview, history };
};
