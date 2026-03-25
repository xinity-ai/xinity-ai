import { rootOs, withInstanceAdmin } from "../root";
import { z } from "zod";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { userT, memberT, organizationT, modelDeploymentT, modelInstallationT, sql, eq, or, ilike, count, and } from "common-db";

const log = rootLogger.child({ name: "instance-admin.procedure" });
const tags = ["Instance Admin"];

const RoleSchema = z.enum(["owner", "admin", "member", "labeler", "viewer", "pending"]);

/** Returns true when the organization has only one owner (removing or demoting them would leave it ownerless). */
async function isSoleOwner(organizationId: string): Promise<boolean> {
  const owners = await getDB()
    .select({ userId: memberT.userId })
    .from(memberT)
    .where(and(eq(memberT.organizationId, organizationId), eq(memberT.role, "owner")))
    .limit(2);
  return owners.length <= 1;
}

// ── Users ────────────────────────────────────────────────────────────────

const listUsers = rootOs
  .meta({ mcp: false })
  .use(withInstanceAdmin)
  .route({ method: "GET", path: "/users", tags, summary: "List all users" })
  .input(z.object({
    page: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(100).default(25),
    search: z.string().optional(),
  }))
  .handler(async ({ input }) => {
    const db = getDB();
    const offset = (input.page - 1) * input.limit;
    const searchFilter = input.search
      ? or(
          ilike(userT.name, `%${input.search}%`),
          ilike(userT.email, `%${input.search}%`),
        )
      : undefined;

    const [users, [{ total }]] = await Promise.all([
      db
        .select({
          id: userT.id,
          name: userT.name,
          email: userT.email,
          emailVerified: userT.emailVerified,
          banned: userT.banned,
          banReason: userT.banReason,
          banExpires: userT.banExpires,
          createdAt: userT.createdAt,
        })
        .from(userT)
        .where(searchFilter)
        .orderBy(userT.createdAt)
        .limit(input.limit)
        .offset(offset),
      db.select({ total: count() }).from(userT).where(searchFilter),
    ]);

    // Fetch memberships for all returned users in one query
    const userIds = users.map((u) => u.id);
    const memberships = userIds.length
      ? await db
          .select({
            userId: memberT.userId,
            role: memberT.role,
            organizationId: memberT.organizationId,
            organizationName: organizationT.name,
            organizationSlug: organizationT.slug,
          })
          .from(memberT)
          .innerJoin(organizationT, eq(memberT.organizationId, organizationT.id))
          .where(sql`${memberT.userId} IN ${userIds}`)
      : [];

    // Group memberships by userId
    const membershipsByUser = new Map<string, typeof memberships>();
    for (const m of memberships) {
      const list = membershipsByUser.get(m.userId) ?? [];
      list.push(m);
      membershipsByUser.set(m.userId, list);
    }

    return {
      users: users.map((u) => ({
        ...u,
        memberships: membershipsByUser.get(u.id) ?? [],
      })),
      total,
      page: input.page,
      limit: input.limit,
    };
  });

const banUser = rootOs
  .meta({ mcp: false })
  .use(withInstanceAdmin)
  .route({ method: "POST", path: "/users/ban", tags, summary: "Ban a user" })
  .input(z.object({
    userId: z.string(),
    reason: z.string().optional(),
    expiresAt: z.string().datetime().optional(),
  }))
  .handler(async ({ input, context, errors }) => {
    if (input.userId === context.session.user.id) {
      throw errors.FORBIDDEN({ message: "You cannot ban yourself" });
    }
    log.info({ userId: input.userId, reason: input.reason }, "Banning user");
    await getDB()
      .update(userT)
      .set({
        banned: true,
        banReason: input.reason ?? null,
        banExpires: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .where(eq(userT.id, input.userId));
    return { success: true };
  });

const unbanUser = rootOs
  .meta({ mcp: false })
  .use(withInstanceAdmin)
  .route({ method: "POST", path: "/users/unban", tags, summary: "Unban a user" })
  .input(z.object({ userId: z.string() }))
  .handler(async ({ input }) => {
    log.info({ userId: input.userId }, "Unbanning user");
    await getDB()
      .update(userT)
      .set({ banned: false, banReason: null, banExpires: null })
      .where(eq(userT.id, input.userId));
    return { success: true };
  });

const addUserToOrganization = rootOs
  .meta({ mcp: false })
  .use(withInstanceAdmin)
  .route({ method: "POST", path: "/users/add-to-org", tags, summary: "Add user to organization" })
  .input(z.object({
    userId: z.string(),
    organizationId: z.string(),
    role: RoleSchema,
  }))
  .handler(async ({ input, errors }) => {
    const db = getDB();
    // Check if already a member
    const [existing] = await db
      .select({ id: memberT.id })
      .from(memberT)
      .where(and(eq(memberT.userId, input.userId), eq(memberT.organizationId, input.organizationId)))
      .limit(1);
    if (existing) {
      throw errors.FORBIDDEN({ message: "User is already a member of this organization" });
    }
    log.info(input, "Adding user to organization");
    await db.insert(memberT).values({
      id: crypto.randomUUID(),
      userId: input.userId,
      organizationId: input.organizationId,
      role: input.role,
    });
    return { success: true };
  });

const removeUserFromOrganization = rootOs
  .meta({ mcp: false })
  .use(withInstanceAdmin)
  .route({ method: "POST", path: "/users/remove-from-org", tags, summary: "Remove user from organization" })
  .input(z.object({
    userId: z.string(),
    organizationId: z.string(),
  }))
  .handler(async ({ input, errors }) => {
    const db = getDB();

    // Check if the user is the sole owner of this organization
    const [membership] = await db
      .select({ role: memberT.role })
      .from(memberT)
      .where(and(eq(memberT.userId, input.userId), eq(memberT.organizationId, input.organizationId)))
      .limit(1);

    if (membership?.role === "owner" && await isSoleOwner(input.organizationId)) {
      throw errors.FORBIDDEN({ message: "Cannot remove the sole owner of an organization. Transfer ownership first." });
    }

    log.info(input, "Removing user from organization");
    await db
      .delete(memberT)
      .where(and(eq(memberT.userId, input.userId), eq(memberT.organizationId, input.organizationId)));
    return { success: true };
  });

const updateUserRole = rootOs
  .meta({ mcp: false })
  .use(withInstanceAdmin)
  .route({ method: "POST", path: "/users/update-role", tags, summary: "Update user role in organization" })
  .input(z.object({
    userId: z.string(),
    organizationId: z.string(),
    role: RoleSchema,
  }))
  .handler(async ({ input, errors }) => {
    const db = getDB();

    // If demoting an owner, ensure at least one other owner remains
    if (input.role !== "owner") {
      const [current] = await db
        .select({ role: memberT.role })
        .from(memberT)
        .where(and(eq(memberT.userId, input.userId), eq(memberT.organizationId, input.organizationId)))
        .limit(1);

      if (current?.role === "owner" && await isSoleOwner(input.organizationId)) {
        throw errors.FORBIDDEN({ message: "Cannot demote the sole owner of an organization. Transfer ownership first." });
      }
    }

    log.info(input, "Updating user role");
    await db
      .update(memberT)
      .set({ role: input.role })
      .where(and(eq(memberT.userId, input.userId), eq(memberT.organizationId, input.organizationId)));
    return { success: true };
  });

// ── Organizations ────────────────────────────────────────────────────────

const listOrganizations = rootOs
  .meta({ mcp: false })
  .use(withInstanceAdmin)
  .route({ method: "GET", path: "/organizations", tags, summary: "List all organizations" })
  .input(z.object({
    page: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(100).default(25),
    search: z.string().optional(),
  }))
  .handler(async ({ input }) => {
    const db = getDB();
    const offset = (input.page - 1) * input.limit;
    const searchFilter = input.search
      ? or(
          ilike(organizationT.name, `%${input.search}%`),
          ilike(organizationT.slug, `%${input.search}%`),
        )
      : undefined;

    const [orgs, [{ total }]] = await Promise.all([
      db
        .select({
          id: organizationT.id,
          name: organizationT.name,
          slug: organizationT.slug,
          logo: organizationT.logo,
          createdAt: organizationT.createdAt,
          ssoSelfManage: organizationT.ssoSelfManage,
          memberCount: sql<number>`(SELECT count(*) FROM "member" WHERE "member"."organization_id" = "organization"."id")`.as("memberCount"),
          deploymentCount: sql<number>`(SELECT count(*) FROM "model_deployment" WHERE "model_deployment"."organization_id" = "organization"."id" AND "model_deployment"."deleted_at" IS NULL)`.as("deploymentCount"),
          totalCapacity: sql<number>`(
            SELECT coalesce(sum("model_installation"."est_capacity"), 0)
            FROM "model_deployment" md
            INNER JOIN "model_installation" ON "model_installation"."model" = md."model_specifier"
            WHERE md."organization_id" = "organization"."id"
              AND md."deleted_at" IS NULL
          )`.as("total_capacity"),
        })
        .from(organizationT)
        .where(searchFilter)
        .orderBy(organizationT.createdAt)
        .limit(input.limit)
        .offset(offset),
      db.select({ total: count() }).from(organizationT).where(searchFilter),
    ]);

    return { organizations: orgs, total, page: input.page, limit: input.limit };
  });

const getOrganizationMembers = rootOs
  .meta({ mcp: false })
  .use(withInstanceAdmin)
  .route({ method: "GET", path: "/organizations/members", tags, summary: "List members of an organization" })
  .input(z.object({ organizationId: z.string() }))
  .handler(async ({ input }) => {
    const members = await getDB()
      .select({
        userId: memberT.userId,
        role: memberT.role,
        memberCreatedAt: memberT.createdAt,
        userName: userT.name,
        userEmail: userT.email,
        userBanned: userT.banned,
      })
      .from(memberT)
      .innerJoin(userT, eq(memberT.userId, userT.id))
      .where(eq(memberT.organizationId, input.organizationId))
      .orderBy(memberT.createdAt);
    return { members };
  });

const setSsoSelfManage = rootOs
  .meta({ mcp: false })
  .use(withInstanceAdmin)
  .route({ method: "POST", path: "/organizations/sso-self-manage", tags, summary: "Set SSO self-management for an organization" })
  .input(z.object({
    organizationId: z.string(),
    enabled: z.boolean(),
  }))
  .handler(async ({ input }) => {
    log.info({ organizationId: input.organizationId, enabled: input.enabled }, "Setting SSO self-manage");
    await getDB()
      .update(organizationT)
      .set({ ssoSelfManage: input.enabled })
      .where(eq(organizationT.id, input.organizationId));
    return { success: true };
  });

export const instanceAdminRouter = rootOs.prefix("/instance-admin").router({
  listUsers,
  banUser,
  unbanUser,
  addUserToOrganization,
  removeUserFromOrganization,
  updateUserRole,
  listOrganizations,
  getOrganizationMembers,
  setSsoSelfManage,
});
