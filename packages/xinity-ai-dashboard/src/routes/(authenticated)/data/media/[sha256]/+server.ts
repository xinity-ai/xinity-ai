/**
 * GET /data/media/[sha256]
 *
 * Serves a media object by its SHA-256, redirecting to a presigned URL when the object is in
 * S3 and returning the bytes directly when the database holds them.
 */
import type { RequestHandler } from "./$types";
import { auth } from "$lib/server/auth-server";
import { getPresignedUrl, readMediaObject } from "$lib/server/image-store";
import { isMediaDigest } from "common-env/media-ref";
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

  const { sha256 } = params;
  if (!sha256 || !isMediaDigest(sha256)) {
    error(400, "Invalid media reference");
  }

  const presignedUrl = await getPresignedUrl(sha256, orgId);
  if (presignedUrl) {
    return new Response(null, {
      status: 302,
      headers: { Location: presignedUrl },
    });
  }

  const object = await readMediaObject(sha256, orgId);
  if (!object) {
    error(404, "Media object not found");
  }

  return new Response(new Blob([object.bytes]), {
    headers: {
      "Content-Type": object.mimeType,
      "Cache-Control": "private, max-age=900",
    },
  });
};
