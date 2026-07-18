/**
 * ORPC procedures for reading the audit trail. Owner/admin only (via the
 * `auditLog` resource), scoped to the caller's active organization.
 */
import { rootOs, withOrganization, requirePermission } from "../root";
import { z } from "zod";
import { auditEventT, sql } from "common-db";
import { getDB } from "$lib/server/db";
import { hasFeature } from "$lib/server/license";

const tags = ["Audit"];

const exportAudit = rootOs
  .use(withOrganization)
  .use(requirePermission({ auditLog: ["read"] }))
  .meta({ mcp: false })
  .route({ path: "/export", method: "GET", tags, summary: "Export Audit Events" })
  .input(z.object({
    from: z.coerce.date(),
    to: z.coerce.date().optional(),
  }))
  .handler(async ({ context, input, errors }) => {
    if (!hasFeature("audit-log")) {
      throw errors.FORBIDDEN({ message: "Audit log export requires an Enterprise license." });
    }
    const to = input.to ?? new Date();
    return getDB()
      .select()
      .from(auditEventT)
      .where(sql`${auditEventT.organizationId} = ${context.activeOrganizationId} AND ${auditEventT.createdAt} >= ${input.from} AND ${auditEventT.createdAt} <= ${to}`)
      .orderBy(auditEventT.createdAt);
  });

export const auditRouter = rootOs.prefix("/audit").router({
  export: exportAudit,
});
