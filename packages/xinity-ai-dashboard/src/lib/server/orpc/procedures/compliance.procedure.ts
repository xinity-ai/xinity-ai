import { rootOs, withOrganization, requirePermission } from "../root";
import { z } from "zod";
import { desc, eq, retentionPolicyT, retentionRunT } from "common-db";
import { getDB } from "$lib/server/db";

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

export const complianceRouter = rootOs.prefix("/compliance").router({
  getRetentionPolicy,
  setRetentionPolicy,
  listRetentionRuns,
});
