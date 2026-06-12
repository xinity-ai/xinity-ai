import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { and, complianceArtifactT, eq } from "common-db";
import { getDB } from "$lib/server/db";
import { recordAudit } from "$lib/server/audit";
import { requireComplianceAccess } from "$lib/server/compliance/route-guards";
import { invalidatePostureCache } from "$lib/server/compliance/checks";

const artifactInOrg = (artifactId: string, organizationId: string) => and(
  eq(complianceArtifactT.id, artifactId),
  eq(complianceArtifactT.organizationId, organizationId),
);

/** Download an organizational compliance artifact. */
export const GET: RequestHandler = async ({ request, params, locals }) => {
  const { session, organizationId } = await requireComplianceAccess(request, "read");

  const [artifact] = await getDB()
    .select()
    .from(complianceArtifactT)
    .where(artifactInOrg(params.artifactId, organizationId))
    .limit(1);
  if (!artifact) error(404, "Artifact not found");

  await recordAudit(
    { traceId: locals.traceId, session, activeOrganizationId: organizationId },
    {
      action: "compliance-artifact.download",
      resourceType: "complianceArtifact",
      resourceId: artifact.id,
      details: { kind: artifact.kind, fileName: artifact.fileName },
    },
  );

  return new Response(new Uint8Array(artifact.data), {
    headers: {
      "Content-Type": artifact.mimeType,
      "Content-Length": String(artifact.size),
      "Content-Disposition": `attachment; filename="${artifact.fileName.replace(/"/g, "")}"`,
    },
  });
};

/** Remove an organizational compliance artifact. */
export const DELETE: RequestHandler = async ({ request, params, locals }) => {
  const { session, organizationId } = await requireComplianceAccess(request, "update");

  const [deleted] = await getDB()
    .delete(complianceArtifactT)
    .where(artifactInOrg(params.artifactId, organizationId))
    .returning({ id: complianceArtifactT.id, kind: complianceArtifactT.kind, fileName: complianceArtifactT.fileName });
  if (!deleted) error(404, "Artifact not found");

  await recordAudit(
    { traceId: locals.traceId, session, activeOrganizationId: organizationId },
    {
      action: "compliance-artifact.delete",
      resourceType: "complianceArtifact",
      resourceId: deleted.id,
      details: { kind: deleted.kind, fileName: deleted.fileName },
    },
  );
  invalidatePostureCache(organizationId);

  return json({ success: true });
};
