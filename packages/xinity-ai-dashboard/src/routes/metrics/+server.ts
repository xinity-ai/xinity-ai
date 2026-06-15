/**
 * Prometheus metrics endpoint with optional basic auth.
 */
import type { RequestHandler } from "./$types";
import { metricRegister, isMetricsAuthorized } from "$lib/server/metrics";
import { error } from "@sveltejs/kit";

/** Serves metrics in Prometheus text format. */
export const GET: RequestHandler = async ({ request }) => {
  if (!isMetricsAuthorized(request)) {
    error(401);
  }
  const metrics = await metricRegister.metrics();
  return new Response(metrics, {
    headers: { "Content-Type": metricRegister.contentType },
  });
};
