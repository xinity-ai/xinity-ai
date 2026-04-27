/**
 * POST /modelhub/test-embed
 *
 * Authenticated server-side proxy for embedding requests issued by the "Test"
 * button on embedding-model deployment cards. Forwards the body to
 * `${GATEWAY_URL}/v1/embeddings` and returns the JSON response untouched.
 */
import type { RequestHandler } from "./$types";
import { auth } from "$lib/server/auth-server";
import { serverEnv } from "$lib/server/serverenv";
import { error } from "@sveltejs/kit";

export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await auth.api.getSession(locals.request);
  if (!session) error(401, "Unauthorized");
  if (!session.session.activeOrganizationId) error(403, "No active organization");

  let body: { apiKey?: unknown; model?: unknown; input?: unknown };
  try {
    body = await request.json();
  } catch {
    error(400, "Invalid JSON body");
  }

  const { apiKey, model, input } = body;
  if (typeof apiKey !== "string" || !apiKey) error(400, "Missing apiKey");
  if (typeof model !== "string" || !model) error(400, "Missing model");
  if (typeof input !== "string" || !input) error(400, "Missing input");

  const upstream = await fetch(`${serverEnv.GATEWAY_URL.replace(/\/$/, "")}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input }),
    signal: request.signal,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
  });
};
