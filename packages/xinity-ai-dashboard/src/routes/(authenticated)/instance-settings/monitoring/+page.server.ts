import type { PageServerLoad } from "./$types";
import { getDB } from "$lib/server/db";
import { aiNodeT, isNull, sql } from "common-db";
import { serverEnv } from "$lib/server/serverenv";

/**
 * A Prometheus scrape target (host:port + scheme) derived from a service's
 * configured base URL. Port falls back to the scheme default (443/80), not an
 * internal port, so a reverse-proxied https URL yields a reachable target.
 */
function scrapeTarget(rawUrl: string): { target: string; scheme: string } {
  const u = new URL(rawUrl);
  const scheme = u.protocol.replace(":", "");
  const port = u.port || (scheme === "https" ? "443" : "80");
  return { target: `${u.hostname}:${port}`, scheme };
}

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
