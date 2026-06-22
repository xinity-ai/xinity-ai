/**
 * Prometheus HTTP service discovery endpoint for daemon /metrics targets.
 *
 * Public route (sibling of /metrics, outside the authenticated group). Reuses
 * the METRICS_AUTH Basic-auth policy: open when METRICS_AUTH is unset, otherwise
 * a matching credential is required. Prometheus points an http_sd_config here.
 */
import type { RequestHandler } from "./$types";
import { error } from "@sveltejs/kit";
import { isMetricsAuthorized } from "$lib/server/metrics";
import { buildDaemonServiceDiscovery, listDaemonSdNodes } from "$lib/server/compute/prometheus-sd";

export const GET: RequestHandler = async ({ request }) => {
  if (!isMetricsAuthorized(request)) {
    error(401);
  }
  const groups = buildDaemonServiceDiscovery(await listDaemonSdNodes());
  return new Response(JSON.stringify(groups), {
    headers: { "Content-Type": "application/json" },
  });
};
