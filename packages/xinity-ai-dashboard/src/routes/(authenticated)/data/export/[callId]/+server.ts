/**
 * GET /data/export/[callId]
 *
 * Exports a logged call as a self-contained JSON file. Calls still held in the legacy `api_call`
 * table are normalized into the `inference_call` shape, so the file format does not change again
 * when that table is dropped. Any xinity-media:// image and audio references are resolved to base64
 * so the export stands alone.
 */
import type { RequestHandler } from "./$types";
import { auth } from "$lib/server/auth-server";
import { getDB } from "$lib/server/db";
import { apiCallT, inferenceCallT, sql, type ApiCallResponse, type ApiCallInputMessage, type ApiCallInputMessageContent } from "common-db";
import { resolveCallMessages } from "$lib/server/lib/call-messages";
import { inferenceToCallRecord, legacyToCallRecord, type CallRecord } from "$lib/server/lib/call-record";
import { resolveFirstRating } from "$lib/server/lib/call-ratings";
import { readMediaObject, resolveToDataUri } from "$lib/server/image-store";
import { parseMediaRef } from "common-env/media-ref";
import { error } from "@sveltejs/kit";

export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await auth.api.getSession({ headers: locals.request.headers });
  if (!session) {
    error(401, "Unauthorized");
  }

  const orgId = session.session.activeOrganizationId;
  if (!orgId) {
    error(403, "No active organization");
  }

  const { callId } = params;

  const [call, rating] = await Promise.all([
    loadCall(callId, orgId),
    resolveFirstRating(callId),
  ]);

  if (!call) {
    error(404, "Call not found");
  }

  const payload = {
    call: {
      ...call,
      inputMessages: await resolveMessagesMedia(call.inputMessages, orgId),
      outputMessages: await resolveMessagesMedia(call.outputMessages, orgId),
    },
    rating: (rating ?? null) satisfies ApiCallResponse | null,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="call-${callId}.json"`,
    },
  });
};

async function loadCall(callId: string, orgId: string): Promise<CallRecord | null> {
  const [inference] = await getDB()
    .select()
    .from(inferenceCallT)
    .where(sql`${inferenceCallT.id} = ${callId} AND ${inferenceCallT.organizationId} = ${orgId}`)
    .limit(1);

  if (inference) {
    const messages = (await resolveCallMessages([callId])).get(callId);
    return inferenceToCallRecord(inference, messages);
  }

  const [legacy] = await getDB()
    .select()
    .from(apiCallT)
    .where(sql`${apiCallT.id} = ${callId} AND ${apiCallT.organizationId} = ${orgId}`)
    .limit(1);

  return legacy ? legacyToCallRecord(legacy) : null;
}

async function resolveMediaPart(
  part: ApiCallInputMessageContent,
  orgId: string,
): Promise<ApiCallInputMessageContent> {
  if (part.type === "image_url") {
    const sha256 = parseMediaRef(part.image_url.url);
    if (!sha256) return part;
    const dataUri = await resolveToDataUri(sha256, orgId);
    return {
      type: "image_url",
      image_url: { url: dataUri ?? part.image_url.url },
    };
  }
  if (part.type === "input_audio") {
    const sha256 = parseMediaRef(part.input_audio.data);
    if (!sha256) return part;
    const object = await readMediaObject(sha256, orgId);
    if (!object) return part;
    return {
      type: "input_audio",
      input_audio: { data: Buffer.from(object.bytes).toString("base64"), format: part.input_audio.format },
    };
  }
  return part;
}

async function resolveMessageMedia(
  msg: ApiCallInputMessage,
  orgId: string,
): Promise<ApiCallInputMessage> {
  if (!Array.isArray(msg.content)) return msg;
  const resolvedParts = await Promise.all(msg.content.map((part) => resolveMediaPart(part, orgId)));
  return { ...msg, content: resolvedParts };
}

function resolveMessagesMedia(
  messages: ApiCallInputMessage[],
  orgId: string,
): Promise<ApiCallInputMessage[]> {
  return Promise.all(messages.map((msg) => resolveMessageMedia(msg, orgId)));
}
