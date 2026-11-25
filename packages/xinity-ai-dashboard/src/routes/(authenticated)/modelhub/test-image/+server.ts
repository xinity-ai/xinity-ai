/**
 * POST /modelhub/test-image
 *
 * Authenticated server-side proxy for image generation requests issued by the "Test"
 * button on image-model deployment cards. Forwards the body to
 * `${GATEWAY_URL}/v1/images/generations` and returns the JSON response untouched.
 */
import type { RequestHandler } from "./$types";
import { requireSession } from "$lib/server/lib/auth/session";
import { fetchGateway } from "$lib/server/lib/models/gateway-proxy";
import { error } from "@sveltejs/kit";

export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await requireSession(locals.request.headers);
  if (!session.session.activeOrganizationId) error(403, "No active organization");

  let body: { apiKey?: unknown; model?: unknown; prompt?: unknown };
  try {
    body = await request.json();
  } catch {
    error(400, "Invalid JSON body");
  }

  const { apiKey, model, prompt } = body;
  if (typeof apiKey !== "string" || !apiKey) error(400, "Missing apiKey");
  if (typeof model !== "string" || !model) error(400, "Missing model");
  if (typeof prompt !== "string" || !prompt) error(400, "Missing prompt");

  const upstream = await fetchGateway("/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, prompt, response_format: "b64_json" }),
    signal: request.signal,
  }, locals.traceId);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
  });
};
