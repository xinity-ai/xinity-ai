/**
 * POST /modelhub/test-chat
 *
 * Authenticated server-side proxy for chat-completion requests issued by the
 * "Test" button on deployment cards. Streams the SSE body from the gateway
 * straight back to the browser. Lives behind the dashboard session so we
 * don't need cross-origin support on the gateway.
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
    messages?: unknown;
    store?: unknown;
    applicationName?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    error(400, "Invalid JSON body");
  }

  const { apiKey, model, messages, store, applicationName } = body;
  if (typeof apiKey !== "string" || !apiKey) error(400, "Missing apiKey");
  if (typeof model !== "string" || !model) error(400, "Missing model");
  if (!Array.isArray(messages) || messages.length === 0) error(400, "Missing messages");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    Accept: "text/event-stream",
  };
  if (typeof applicationName === "string" && applicationName) {
    headers["X-Application"] = applicationName;
  }

  const upstream = await fetch(`${serverEnv.GATEWAY_URL.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      store: typeof store === "boolean" ? store : false,
    }),
    signal: request.signal,
  });

  // Pass the upstream response through unchanged (status + body). For SSE
  // success this streams chunks; for non-2xx the gateway returns a small JSON
  // error body that the client will handle.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
};
