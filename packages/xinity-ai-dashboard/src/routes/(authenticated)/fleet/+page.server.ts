import type { PageServerLoad } from "./$types";
import { buildFleetOverview, buildFleetHistory } from "$lib/server/orpc/procedures/fleet.procedure";

export const load: PageServerLoad = async () => {
  const [overview, history] = await Promise.all([
    buildFleetOverview(24),
    buildFleetHistory(24),
  ]);
  return { overview, history };
};
