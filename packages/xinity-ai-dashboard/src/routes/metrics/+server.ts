/**
 * Prometheus metrics endpoint with optional basic auth.
 */
import type { RequestHandler } from "./$types";
import { metricRegister } from "$lib/server/metrics";
import { error } from "@sveltejs/kit";
import { serverEnv } from "$lib/server/serverenv";

const BASIC_PREFIX = "Basic ";

/** Validates the request's basic auth header against server config. */
function checkBasicAuth(request: Request) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith(BASIC_PREFIX)) {
    return false;
  }
  const decodedCredentials = Buffer.from(authHeader.slice(BASIC_PREFIX.length), "base64").toString();
  return decodedCredentials === serverEnv.METRICS_AUTH;
}

/** Serves metrics in Prometheus text format. */
export const GET: RequestHandler = async ({ request }) => {
  if (serverEnv.METRICS_AUTH && !checkBasicAuth(request)) {
    error(401);
  }
  const metrics = await metricRegister.metrics();
  return new Response(metrics, {
    headers: { "Content-Type": metricRegister.contentType },
  });
};
