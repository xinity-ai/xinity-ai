/**
 * GET /data/export/[callId]
 *
 * Authenticated endpoint that exports a logged API call as a self-contained
 * JSON file. Any xinity-media:// image references in inputMessages are
 * resolved to base64 data URIs so the exported file is fully standalone.
 */
import type { RequestHandler } from "./$types";
import { auth } from "$lib/server/auth-server";
import { getDB } from "$lib/server/db";
import { apiCallT, apiCallResponseT, and, eq } from "common-db";
import { resolveToDataUri, parseMediaRef } from "$lib/server/image-store";
import type { ApiCallInputMessage, ApiCallInputMessageContent } from "common-db";
import { error } from "@sveltejs/kit";

export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await auth.api.getSession(locals.request);
  if (!session) {
    error(401, "Unauthorized");
  }

  const orgId = session.session.activeOrganizationId;
  if (!orgId) {
    error(403, "No active organization");
  }

  const { callId } = params;

  const [call] = await getDB()
    .select()
    .from(apiCallT)
    .where(and(eq(apiCallT.id, callId), eq(apiCallT.organizationId, orgId)))
    .limit(1);

  if (!call) {
    error(404, "Call not found");
  }

  const [rating] = await getDB()
    .select()
    .from(apiCallResponseT)
    .where(eq(apiCallResponseT.apiCallId, callId))
    .limit(1);

  const resolvedMessages = await resolveMessagesImages(call.inputMessages, orgId);

  const payload = {
    call: { ...call, inputMessages: resolvedMessages },
    rating: rating ?? null,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="call-${callId}.json"`,
    },
  });
};

async function resolveImagePart(
  part: ApiCallInputMessageContent,
  orgId: string,
): Promise<ApiCallInputMessageContent> {
  if (part.type !== "image_url") return part;
  const sha256 = parseMediaRef(part.image_url.url);
  if (!sha256) return part;
  const dataUri = await resolveToDataUri(sha256, orgId);
  return {
    type: "image_url",
    image_url: { url: dataUri ?? part.image_url.url },
  };
}

async function resolveMessageImages(
  msg: ApiCallInputMessage,
  orgId: string,
): Promise<ApiCallInputMessage> {
  if (!Array.isArray(msg.content)) return msg;
  const resolvedParts = await Promise.all(msg.content.map((part) => resolveImagePart(part, orgId)));
  return { ...msg, content: resolvedParts };
}

function resolveMessagesImages(
  messages: ApiCallInputMessage[],
  orgId: string,
): Promise<ApiCallInputMessage[]> {
  return Promise.all(messages.map((msg) => resolveMessageImages(msg, orgId)));
}
