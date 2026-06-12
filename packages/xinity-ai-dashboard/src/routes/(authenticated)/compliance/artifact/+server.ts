import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { complianceArtifactT } from "common-db";
import { getDB } from "$lib/server/db";
import { recordAudit } from "$lib/server/audit";
import { requireComplianceAccess } from "$lib/server/compliance/route-guards";
import { ORGANIZATIONAL_KINDS, invalidatePostureCache } from "$lib/server/compliance/checks";

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const REVIEW_BY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Upload (or replace) an organizational compliance artifact for a check kind. */
export const POST: RequestHandler = async ({ request, locals }) => {
  const { session, organizationId } = await requireComplianceAccess(request, "update");

  const form = await request.formData();
  const file = form.get("file");
  const kind = form.get("kind");
  const note = form.get("note");
  const reviewBy = form.get("reviewBy");

  if (!(file instanceof File) || file.size === 0) error(400, "A non-empty file is required");
  if (typeof kind !== "string" || !ORGANIZATIONAL_KINDS.has(kind)) error(400, "Unknown artifact kind");
  if (file.size > MAX_ARTIFACT_BYTES) error(413, "Artifact exceeds the 20 MB limit");
  if (reviewBy !== null && (typeof reviewBy !== "string" || !REVIEW_BY_PATTERN.test(reviewBy))) {
    error(400, "reviewBy must be a YYYY-MM-DD date");
  }

  const values = {
    organizationId,
    kind,
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    data: Buffer.from(await file.arrayBuffer()),
    size: file.size,
    note: typeof note === "string" && note.length > 0 ? note : null,
    reviewBy: reviewBy as string | null,
    uploadedByUserId: session.user.id,
  };

  const [artifact] = await getDB()
    .insert(complianceArtifactT)
    .values(values)
    .onConflictDoUpdate({
      target: [complianceArtifactT.organizationId, complianceArtifactT.kind],
      set: values,
    })
    .returning({ id: complianceArtifactT.id });

  await recordAudit(
    { traceId: locals.traceId, session, activeOrganizationId: organizationId },
    {
      action: "compliance-artifact.upload",
      resourceType: "complianceArtifact",
      resourceId: artifact.id,
      details: { kind, fileName: file.name, size: file.size, reviewBy: values.reviewBy },
    },
  );
  invalidatePostureCache(organizationId);

  return json({ id: artifact.id, kind, fileName: file.name, size: file.size });
};
