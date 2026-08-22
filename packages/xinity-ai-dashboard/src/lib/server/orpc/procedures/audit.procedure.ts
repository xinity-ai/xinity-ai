import { rootOs, withOrganization, requirePermission } from "../root";
import { z } from "zod";
import { auditEventT, auditResultEnum, sql, and } from "common-db";
import { getDB } from "$lib/server/db";
import { hasFeature } from "$lib/server/license";
import { isInstanceAdmin } from "$lib/server/serverenv";

const tags = ["Audit"];
const EXPORT_ROW_CAP = 10_000;

const auditFilters = z.object({
  actorId: z.string().optional(),
  action: z.string().optional(),
  resource: z.string().optional(),
  result: z.enum(auditResultEnum.enumValues).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function buildWhereClause(orgId: string, filters: z.infer<typeof auditFilters>, includeInstanceEvents = false) {
  const orgCondition = includeInstanceEvents
    ? sql`(${auditEventT.organizationId} = ${orgId} OR ${auditEventT.organizationId} IS NULL)`
    : sql`${auditEventT.organizationId} = ${orgId}`;
  const conditions = [orgCondition];
  if (filters.actorId) {
    conditions.push(sql`${auditEventT.actorId} = ${filters.actorId}`);
  }
  if (filters.action) {
    conditions.push(sql`${auditEventT.action} = ${filters.action}`);
  }
  if (filters.resource) {
    conditions.push(sql`${auditEventT.resource} = ${filters.resource}`);
  }
  if (filters.result) {
    conditions.push(sql`${auditEventT.result} = ${filters.result}`);
  }
  if (filters.from) {
    conditions.push(sql`${auditEventT.createdAt} >= ${filters.from.toISOString()}`);
  }
  if (filters.to) {
    conditions.push(sql`${auditEventT.createdAt} <= ${filters.to.toISOString()}`);
  }
  return and(...conditions);
}

const listAudit = rootOs
  .use(withOrganization)
  .use(requirePermission({ auditLog: ["read"] }))
  .meta({ mcp: false })
  .route({ path: "/list", method: "GET", tags, summary: "List Audit Events" })
  .input(auditFilters.extend({
    cursor: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    includeInstanceEvents: z.boolean().default(false),
  }))
  .handler(async ({ context, input, errors }) => {
    if (!hasFeature("audit-log")) {
      throw errors.FORBIDDEN({ message: "Audit log requires an Enterprise license." });
    }

    const { cursor, limit, includeInstanceEvents, ...filters } = input;
    const includeInstance = includeInstanceEvents && isInstanceAdmin(context.session.user.email);
    const where = buildWhereClause(context.activeOrganizationId, filters, includeInstance);

    const cursorClause = cursor
      ? sql`
        ${where}
      AND
        ${auditEventT.createdAt} < ${cursor.toISOString()}
      `
      : where;

    const events = await getDB()
      .select()
      .from(auditEventT)
      .where(cursorClause)
      .orderBy(sql`${auditEventT.createdAt} DESC`)
      .limit(limit + 1);

    const hasMore = events.length > limit;
    if (hasMore) {
      events.pop();
    }

    return {
      events,
      nextCursor: hasMore ? events[events.length - 1]!.createdAt.toISOString() : null,
    };
  });

const exportAudit = rootOs
  .use(withOrganization)
  .use(requirePermission({ auditLog: ["read"] }))
  .meta({ mcp: false })
  .route({ path: "/export", method: "GET", tags, summary: "Export Audit Events" })
  .input(auditFilters.pick({ from: true, to: true }).required({ from: true }).extend({
    includeInstanceEvents: z.boolean().default(false),
  }))
  .handler(async ({ context, input, errors }) => {
    if (!hasFeature("audit-log")) {
      throw errors.FORBIDDEN({ message: "Audit log export requires an Enterprise license." });
    }
    const includeInstance = input.includeInstanceEvents && isInstanceAdmin(context.session.user.email);
    const where = buildWhereClause(context.activeOrganizationId, {
      from: input.from,
      to: input.to ?? new Date(),
    }, includeInstance);
    const events = await getDB()
      .select()
      .from(auditEventT)
      .where(where)
      .orderBy(sql`${auditEventT.createdAt} ASC`)
      .limit(EXPORT_ROW_CAP);

    return { events, truncated: events.length === EXPORT_ROW_CAP };
  });

export const auditRouter = rootOs.prefix("/audit").router({
  list: listAudit,
  export: exportAudit,
});
