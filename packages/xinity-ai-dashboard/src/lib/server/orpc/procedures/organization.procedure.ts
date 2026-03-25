import { rootOs, withAuth, withOrganization, requirePermission } from "../root";
import { z } from "zod";
import { auth } from "$lib/server/auth-server";
import { rootLogger } from "$lib/server/logging";
import { isInstanceAdmin, serverEnv } from "$lib/server/serverenv";
import { getDB } from "$lib/server/db";
import { notifyOrgMembers } from "$lib/server/notifications/notification.service";
import { NotificationType } from "$lib/server/notifications/events";
import { memberT, userT, organizationT, sql } from "common-db";
import { isRoleAvailable } from "$lib/server/roles";
import { hasFeature } from "$lib/server/license";

const log = rootLogger.child({ name: "organization.procedure" });
const tags = ["Organization"];

const RoleSchema = z.enum(["owner", "admin", "member", "labeler", "viewer", "pending"]);

export const createOrganization = rootOs
  .use(withAuth)
  .route({ path: "/", method: "POST", tags, summary: "Create Organization" })
  .input(z.object({
    name: z.string().min(1),
    slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
    logo: z.string().optional(),
  }))
  .output(z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
  }))
  .handler(async ({ input, context, errors }) => {
    if (!serverEnv.MULTI_TENANT_MODE && !isInstanceAdmin(context.session.user.email)) {
      throw errors.FORBIDDEN({ message: "Only instance admins can create organizations." });
    }

    // License gate: multi-org requires enterprise license
    if (!hasFeature("multi-org")) {
      const existingOrgs = await getDB()
        .select({ id: organizationT.id })
        .from(organizationT)
        .limit(1);
      if (existingOrgs.length > 0) {
        throw errors.FORBIDDEN({ message: "Multiple organizations require an Enterprise license. Upgrade at xinity.ai/pricing." });
      }
    }

    log.info({ name: input.name, slug: input.slug }, "Creating organization");

    const org = await auth.api.createOrganization({
      body: {
        name: input.name,
        slug: input.slug,
        logo: input.logo,
      },
      headers: context.request.headers,
    });

    if (!org) {
      throw errors.INTERNAL_SERVER_ERROR({ message: "Failed to create organization" });
    }

    await auth.api.setActiveOrganization({
      body: { organizationId: org.id },
      headers: context.request.headers,
    });

    return { id: org.id, name: org.name, slug: org.slug };
  });

const update = rootOs
  .use(withOrganization)
  .use(requirePermission({ organization: ["update"] }))
  .route({ path: "/", method: "PATCH", tags, summary: "Update Organization" })
  .input(z.object({
    name: z.string(),
    logo: z.string().optional(),
  }))
  .handler(async ({ input, context, errors }) => {
    const result = await auth.api.updateOrganization({
      body: {
        organizationId: context.activeOrganizationId,
        data: {
          name: input.name,
          logo: input.logo,
        },
      },
      headers: context.request.headers,
    });

    if (!result) {
      throw errors.INTERNAL_SERVER_ERROR({ message: "Failed to update organization" });
    }

    return { success: true };
  });

const inviteMember = rootOs
  .use(withOrganization)
  .use(requirePermission({ invitation: ["create"] }))
  .route({ path: "/invite", method: "POST", tags, summary: "Invite Member" })
  .input(z.object({
    email: z.email(),
    role: RoleSchema,
  }))
  .handler(async ({ input, context, errors }) => {
    if (!isRoleAvailable(input.role)) {
      throw errors.FORBIDDEN({ message: `The "${input.role}" role requires a paid license. Upgrade at xinity.ai/pricing.` });
    }

    const result = await auth.api.createInvitation({
      body: {
        email: input.email,
        role: input.role as any,
        organizationId: context.activeOrganizationId,
      },
      headers: context.request.headers,
    });

    if (!result) {
      throw errors.INTERNAL_SERVER_ERROR({ message: "Failed to send invitation" });
    }

    return { success: true };
  });

const removeMember = rootOs
  .use(withOrganization)
  .use(requirePermission({ member: ["delete"] }))
  .route({ path: "/remove-member", method: "POST", tags, summary: "Remove Member" })
  .input(z.object({
    memberId: z.string(),
  }))
  .handler(async ({ input, context }) => {
    // Look up member name and org name before removal; the member row is deleted by Better Auth
    const [[member], [org]] = await Promise.all([
      getDB()
        .select({ name: userT.name })
        .from(memberT)
        .innerJoin(userT, sql`${userT.id} = ${memberT.userId}`)
        .where(sql`${memberT.id} = ${input.memberId}`)
        .limit(1),
      getDB()
        .select({ name: organizationT.name })
        .from(organizationT)
        .where(sql`${organizationT.id} = ${context.activeOrganizationId}`)
        .limit(1),
    ]);

    await auth.api.removeMember({
      body: {
        memberIdOrEmail: input.memberId,
        organizationId: context.activeOrganizationId,
      },
      headers: context.request.headers,
    });

    if (member) {
      void notifyOrgMembers({
        type: NotificationType.member_removed,
        organizationId: context.activeOrganizationId,
        data: {
          memberName: member.name,
          eventType: "removed",
          role: "",
          orgName: org?.name ?? "",
          dashboardUrl: `${serverEnv.ORIGIN}/organizations`,
        },
      }).catch((err: unknown) => log.error({ err }, "Failed to send member removed notification"));
    }

    return { success: true };
  });

const updateMemberRole = rootOs
  .use(withOrganization)
  .use(requirePermission({ member: ["update"] }))
  .route({ path: "/update-role", method: "POST", tags, summary: "Update Member Role" })
  .input(z.object({
    memberId: z.string(),
    role: RoleSchema,
  }))
  .handler(async ({ input, context, errors }) => {
    if (!isRoleAvailable(input.role)) {
      throw errors.FORBIDDEN({ message: `The "${input.role}" role requires a paid license. Upgrade at xinity.ai/pricing.` });
    }

    const result = await auth.api.updateMemberRole({
      body: {
        memberId: input.memberId,
        role: input.role,
        organizationId: context.activeOrganizationId,
      },
      headers: context.request.headers,
    });

    if (!result) {
      throw errors.INTERNAL_SERVER_ERROR({ message: "Failed to update member role" });
    }

    const [[member], [org]] = await Promise.all([
      getDB()
        .select({ name: userT.name })
        .from(memberT)
        .innerJoin(userT, sql`${userT.id} = ${memberT.userId}`)
        .where(sql`${memberT.id} = ${input.memberId}`)
        .limit(1),
      getDB()
        .select({ name: organizationT.name })
        .from(organizationT)
        .where(sql`${organizationT.id} = ${context.activeOrganizationId}`)
        .limit(1),
    ]);

    if (member) {
      void notifyOrgMembers({
        type: NotificationType.member_role_changed,
        organizationId: context.activeOrganizationId,
        data: {
          memberName: member.name,
          eventType: "role_changed",
          role: input.role,
          orgName: org?.name ?? "",
          dashboardUrl: `${serverEnv.ORIGIN}/organizations`,
        },
      }).catch((err: unknown) => log.error({ err }, "Failed to send member role changed notification"));
    }

    return { success: true };
  });

const cancelInvitation = rootOs
  .use(withOrganization)
  .use(requirePermission({ invitation: ["cancel"] }))
  .route({ path: "/cancel-invitation", method: "POST", tags, summary: "Cancel Invitation" })
  .input(z.object({
    invitationId: z.string(),
  }))
  .handler(async ({ input, context, errors }) => {
    const result = await auth.api.cancelInvitation({
      body: {
        invitationId: input.invitationId,
      },
      headers: context.request.headers,
    });

    if (!result) {
      throw errors.INTERNAL_SERVER_ERROR({ message: "Failed to cancel invitation" });
    }

    return { success: true };
  });

const deleteOrganization = rootOs
  .meta({ mcp: false })
  .use(withOrganization)
  .use(requirePermission({ organization: ["delete"] }))
  .route({ path: "/", method: "DELETE", tags, summary: "Delete Organization" })
  .handler(async ({ context }) => {
    log.info({ organizationId: context.activeOrganizationId }, "Deleting organization");
    await auth.api.deleteOrganization({
      body: {
        organizationId: context.activeOrganizationId,
      },
      headers: context.request.headers,
    });

    return { success: true };
  });

const listOrganizations = rootOs
  .use(withAuth)
  .route({ path: "/", method: "GET", tags, summary: "List Organizations" })
  .handler(async ({ context }) => {
    return await auth.api.listOrganizations({
      headers: context.request.headers,
    });
  });

export const organizationRouter = rootOs.prefix("/organization").router({
  create: createOrganization,
  update,
  list: listOrganizations,
  inviteMember,
  removeMember,
  updateMemberRole,
  cancelInvitation,
  delete: deleteOrganization,
});
