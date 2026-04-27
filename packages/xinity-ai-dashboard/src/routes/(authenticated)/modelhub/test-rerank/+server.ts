/**
 * POST /modelhub/test-rerank
 *
 * Authenticated server-side proxy for rerank requests issued by the "Test"
 * button on rerank-model deployment cards. Forwards the body to
 * `${GATEWAY_URL}/v1/rerank` and returns the JSON response untouched.
 */
import type { RequestHandler } from "./$types";
import { auth } from "$lib/server/auth-server";
import { serverEnv } from "$lib/server/serverenv";
import { error } from "@sveltejs/kit";

export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await auth.api.getSession(locals.request);
  if (!session) error(401, "Unauthorized");
  if (!session.session.activeOrganizationId) error(403, "No active organization");

  let body: {
    apiKey?: unknown;
    model?: unknown;
    query?: unknown;
    documents?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    error(400, "Invalid JSON body");
  }

  const { apiKey, model, query, documents } = body;
  if (typeof apiKey !== "string" || !apiKey) error(400, "Missing apiKey");
  if (typeof model !== "string" || !model) error(400, "Missing model");
  if (typeof query !== "string" || !query) error(400, "Missing query");
  if (!Array.isArray(documents) || documents.length === 0) error(400, "Missing documents");

  const upstream = await fetch(`${serverEnv.GATEWAY_URL.replace(/\/$/, "")}/v1/rerank`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, query, documents }),
    signal: request.signal,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
  });
};
