/**
 * Prometheus metrics endpoint with optional basic auth.
 */
import type { RequestHandler } from "./$types";
import { metricRegister } from "$lib/server/metrics";
import { error } from "@sveltejs/kit";
import { serverEnv } from "$lib/server/serverenv";

/** Validates the request's basic auth header against server config. */
function checkBasicAuth(request: Request) {
  // Get the Authorization header
  const authHeader = request.headers.get("Authorization");

  // Ensure the Authorization header exists and starts with 'Basic '
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return false;
  }
  // Decode the base64 part of the header (remove 'Basic ' prefix)
  const base64Credentials = authHeader.slice(6);
  const decodedCredentials = Buffer.from(base64Credentials, "base64").toString();

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
