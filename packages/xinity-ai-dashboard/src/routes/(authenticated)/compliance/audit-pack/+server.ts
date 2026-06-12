import type { RequestHandler } from "./$types";
import { error } from "@sveltejs/kit";
import { zipSync, strToU8 } from "fflate";
import { recordAudit } from "$lib/server/audit";
import { requireComplianceAccess } from "$lib/server/compliance/route-guards";
import { assembleAuditPack, artifactEntryName } from "$lib/server/compliance/audit-pack";
import { renderAuditPackHtml } from "$lib/server/compliance/report-html";

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_RANGE_DAYS = 90;

function parseDateParam(value: string | null, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) error(400, "Invalid date parameter");
  return parsed;
}

function sanitizeFileComponent(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Generate and download the Audit Evidence Pack as a ZIP. */
export const GET: RequestHandler = async ({ request, url, locals }) => {
  const { session, organizationId } = await requireComplianceAccess(request, "read");

  const to = parseDateParam(url.searchParams.get("to"), new Date());
  const from = parseDateParam(url.searchParams.get("from"), new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS));
  if (from.getTime() >= to.getTime()) error(400, "from must be before to");

  const { data, artifactFiles } = await assembleAuditPack(organizationId, from, to);
  const html = renderAuditPackHtml(data);

  const zipEntries: Record<string, Uint8Array> = {
    "report.html": strToU8(html),
    "evidence/cover.json": strToU8(JSON.stringify(data.cover, null, 2)),
    "evidence/model-register.json": strToU8(JSON.stringify(data.modelRegister, null, 2)),
    "evidence/ropa.json": strToU8(JSON.stringify(data.ropa, null, 2)),
    "evidence/toms.json": strToU8(JSON.stringify(data.toms, null, 2)),
    "evidence/retention.json": strToU8(JSON.stringify(data.retention, null, 2)),
    "evidence/access.json": strToU8(JSON.stringify(data.access, null, 2)),
    "evidence/posture.json": strToU8(JSON.stringify(data.posture, null, 2)),
  };
  for (const artifact of artifactFiles) {
    zipEntries[artifactEntryName(artifact.kind, artifact.fileName)] = new Uint8Array(artifact.data);
  }

  const zip = zipSync(zipEntries, { level: 6 });

  await recordAudit(
    { traceId: locals.traceId, session, activeOrganizationId: organizationId },
    {
      action: "compliance.audit-pack.generate",
      resourceType: "organization",
      resourceId: organizationId,
      details: {
        from: from.toISOString(),
        to: to.toISOString(),
        artifacts: artifactFiles.length,
        missingArtifactKinds: data.missingArtifactKinds,
      },
    },
  );

  const fileName = `audit-pack-${sanitizeFileComponent(data.cover.organizationName)}-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.zip`;
  return new Response(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.length),
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
};
