import { rootOs, withOrganization, requirePermission } from "../root";
import { z } from "zod";
import { and, auditLogT, desc, eq, gte, like, lt, lte, or, retentionPolicyT, retentionRunT, type SQL } from "common-db";
import { getDB } from "$lib/server/db";
import { recordAudit } from "$lib/server/audit";
import { hasFeature } from "$lib/server/license";

const tags = ["Compliance"];

/** Retention periods are capped at 10 years; null means keep forever (an explicit choice). */
const retentionDaysSchema = z.number().int().min(1).max(3650).nullable();

const getRetentionPolicy = rootOs
  .use(withOrganization)
  .use(requirePermission({ compliance: ["read"] }))
  .route({ method: "GET", path: "/retention-policy", tags, summary: "Get retention policy" })
  .handler(async ({ context }) => {
    const [policy] = await getDB()
      .select()
      .from(retentionPolicyT)
      .where(eq(retentionPolicyT.organizationId, context.activeOrganizationId))
      .limit(1);
    return policy ?? null;
  });

const setRetentionPolicy = rootOs
  .use(withOrganization)
  .use(requirePermission({ compliance: ["update"] }))
  .route({ method: "PUT", path: "/retention-policy", tags, summary: "Set retention policy" })
  .input(z.object({
    apiCallRetentionDays: retentionDaysSchema,
    mediaRetentionDays: retentionDaysSchema,
  }))
  .handler(async ({ context, input }) => {
    const values = {
      organizationId: context.activeOrganizationId,
      apiCallRetentionDays: input.apiCallRetentionDays,
      mediaRetentionDays: input.mediaRetentionDays,
      updatedByUserId: context.session.user.id,
    };
    const [policy] = await getDB()
      .insert(retentionPolicyT)
      .values(values)
      .onConflictDoUpdate({ target: retentionPolicyT.organizationId, set: values })
      .returning();
    await recordAudit(context, {
      action: "retention-policy.update",
      resourceType: "retentionPolicy",
      resourceId: context.activeOrganizationId,
      details: {
        apiCallRetentionDays: input.apiCallRetentionDays,
        mediaRetentionDays: input.mediaRetentionDays,
      },
    });
    return policy;
  });

const listRetentionRuns = rootOs
  .use(withOrganization)
  .use(requirePermission({ compliance: ["read"] }))
  .route({ method: "GET", path: "/retention-runs", tags, summary: "List retention runs" })
  .handler(({ context }) => {
    return getDB()
      .select()
      .from(retentionRunT)
      .where(eq(retentionRunT.organizationId, context.activeOrganizationId))
      .orderBy(desc(retentionRunT.startedAt))
      .limit(50);
  });

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const listAuditLog = rootOs
  .use(withOrganization)
  .use(requirePermission({ auditLog: ["read"] }))
  .route({ method: "GET", path: "/audit-log", tags, summary: "List audit log" })
  .input(z.object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    /** Prefix match, e.g. "deployment." for all deployment actions. */
    action: z.string().max(100).optional(),
    actorUserId: z.string().optional(),
    cursor: z.object({ createdAt: z.coerce.date(), id: z.uuid() }).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }))
  .handler(async ({ context, input, errors }) => {
    // Recording is always on; only reading the trail is a licensed feature.
    if (!hasFeature("audit-log")) {
      throw errors.FORBIDDEN({
        message: "The audit log requires a license with the audit-log feature. Upgrade at xinity.ai/xinity-pricing.",
      });
    }

    const conditions: (SQL | undefined)[] = [eq(auditLogT.organizationId, context.activeOrganizationId)];
    if (input.from) conditions.push(gte(auditLogT.createdAt, input.from));
    if (input.to) conditions.push(lte(auditLogT.createdAt, input.to));
    if (input.action) conditions.push(like(auditLogT.action, `${escapeLikePattern(input.action)}%`));
    if (input.actorUserId) conditions.push(eq(auditLogT.actorUserId, input.actorUserId));
    if (input.cursor) {
      conditions.push(or(
        lt(auditLogT.createdAt, input.cursor.createdAt),
        and(eq(auditLogT.createdAt, input.cursor.createdAt), lt(auditLogT.id, input.cursor.id)),
      ));
    }

    const rows = await getDB()
      .select()
      .from(auditLogT)
      .where(and(...conditions))
      .orderBy(desc(auditLogT.createdAt), desc(auditLogT.id))
      .limit(input.limit + 1);

    const hasMore = rows.length > input.limit;
    const entries = hasMore ? rows.slice(0, input.limit) : rows;
    const last = entries.at(-1);
    return {
      entries,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  });

export const complianceRouter = rootOs.prefix("/compliance").router({
  getRetentionPolicy,
  setRetentionPolicy,
  listRetentionRuns,
  listAuditLog,
});
