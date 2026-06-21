import type { PageServerLoad } from "./$types";
import { getDB } from "$lib/server/db";
import { aiNodeT, isNull, sql } from "common-db";
import { serverEnv } from "$lib/server/serverenv";
import { scrapeTarget } from "$lib/server/compute/prometheus-sd";

export const load: PageServerLoad = async () => {
  const db = getDB();
  const [{ count: nodeCount }] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(aiNodeT)
    .where(isNull(aiNodeT.deletedAt));

  const gateway = scrapeTarget(serverEnv.GATEWAY_URL);
  const dashboard = scrapeTarget(serverEnv.ORIGIN);

  return {
    nodeCount,
    gatewayTarget: gateway.target,
    gatewayScheme: gateway.scheme,
    dashboardTarget: dashboard.target,
    dashboardScheme: dashboard.scheme,
    // Follows the dashboard's own origin (scheme/host/port), correct for any ORIGIN.
    daemonSdUrl: new URL("/metrics/sd/daemons", serverEnv.ORIGIN).href,
  };
};
