/**
 * GET /data/media/[sha256]
 *
 * Authenticated endpoint that generates a short-lived presigned URL for a
 * media object identified by its SHA-256 hash and redirects the browser to it.
 * Used to display xinity-media:// images in the call detail view.
 */
import type { RequestHandler } from "./$types";
import { auth } from "$lib/server/auth-server";
import { getPresignedUrl } from "$lib/server/image-store";
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

  const { sha256 } = params;
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
    error(400, "Invalid media reference");
  }

  const presignedUrl = await getPresignedUrl(sha256, orgId);
  if (!presignedUrl) {
    error(404, "Media object not found or S3 not configured");
  }

  return new Response(null, {
    status: 302,
    headers: { Location: presignedUrl },
  });
};
