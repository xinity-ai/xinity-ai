import type { RequestHandler } from "./$types";
import { renderMetrics, isMetricsAuthorized } from "$lib/server/metrics";
import { error } from "@sveltejs/kit";

export const GET: RequestHandler = ({ request }) => {
  if (!isMetricsAuthorized(request)) {
    error(401);
  }
  return new Response(renderMetrics(), {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
};
