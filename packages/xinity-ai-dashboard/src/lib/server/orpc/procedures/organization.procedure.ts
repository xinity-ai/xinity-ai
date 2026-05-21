import { rootOs, withAuth, withOrganization, requirePermission } from "../root";
import { z } from "zod";
import { auth } from "$lib/server/auth-server";
import { rootLogger } from "$lib/server/logging";
import { isInstanceAdmin, serverEnv } from "$lib/server/serverenv";
import { getDB } from "$lib/server/db";
import { notifyOrgMembers } from "$lib/server/notifications/notification.service";
import { NotificationType } from "$lib/server/notifications/events";
import { memberT, userT, organizationT, invitationT, and, eq } from "common-db";
import { isRoleAvailable, RoleSchema } from "$lib/server/roles";
import { hasFeature } from "$lib/server/license";
import { betterAuthErrorBody } from "$lib/server/better-auth-errors";
import { findOrgName } from "$lib/server/lib/org-queries";

const log = rootLogger.child({ name: "organization.procedure" });
const tags = ["Organization"];

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
    const rlog = log.child({ traceId: context.traceId });
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
        throw errors.FORBIDDEN({ message: "Multiple organizations require an Enterprise license. Upgrade at xinity.ai/xinity-pricing." });
      }
    }

    rlog.info({ name: input.name, slug: input.slug }, "Creating organization");

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
  .errors({ CONFLICT: {}, BAD_REQUEST: {} })
  .route({ path: "/invite", method: "POST", tags, summary: "Invite Member" })
  .input(z.object({
    email: z.email(),
    role: RoleSchema,
  }))
  .handler(async ({ input, context, errors }) => {
    if (!isRoleAvailable(input.role)) {
      throw errors.FORBIDDEN({ message: `The "${input.role}" role requires a paid license. Upgrade at xinity.ai/xinity-pricing.` });
    }

    try {
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
    } catch (err) {
      const body = betterAuthErrorBody(err);
      switch (body?.code) {
        case "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION":
          throw errors.CONFLICT({ message: "This email already has a pending invitation to this organization" });
        case "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION":
          throw errors.CONFLICT({ message: "This user is already a member of this organization" });
        case "INVITATION_LIMIT_REACHED":
          throw errors.FORBIDDEN({ message: "This organization has reached its invitation limit" });
        case "YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE":
          throw errors.FORBIDDEN({ message: "You are not allowed to invite users with this role" });
        case "ROLE_NOT_FOUND":
          throw errors.BAD_REQUEST({ message: "The specified role does not exist" });
        default:
          throw errors.INTERNAL_SERVER_ERROR({
            message: body?.message ?? (err instanceof Error ? err.message : null) ?? "Failed to send invitation",
          });
      }
    }
  });

const removeMember = rootOs
  .use(withOrganization)
  .use(requirePermission({ member: ["delete"] }))
  .route({ path: "/remove-member", method: "POST", tags, summary: "Remove Member" })
  .errors({ NOT_FOUND: {} })
  .input(z.object({
    memberId: z.string(),
  }))
  .handler(async ({ input, context, errors }) => {
    const rlog = log.child({ traceId: context.traceId });
    // Member lookup must be scoped to the active org: a memberId from another org would otherwise reach Better Auth and surface as 500.
    const [memberName, orgName] = await Promise.all([
      findMemberNameInOrg(input.memberId, context.activeOrganizationId),
      findOrgName(context.activeOrganizationId),
    ]);

    if (memberName === undefined) {
      throw errors.NOT_FOUND({ message: "Member not found in this organization" });
    }

    await auth.api.removeMember({
      body: {
        memberIdOrEmail: input.memberId,
        organizationId: context.activeOrganizationId,
      },
      headers: context.request.headers,
    });

    dispatchMemberEventNotification(rlog, context.activeOrganizationId, {
      type: NotificationType.member_removed,
      eventType: "removed",
      role: "",
      memberName,
      orgName: orgName ?? "",
    });

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
    const rlog = log.child({ traceId: context.traceId });
    if (!isRoleAvailable(input.role)) {
      throw errors.FORBIDDEN({ message: `The "${input.role}" role requires a paid license. Upgrade at xinity.ai/xinity-pricing.` });
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

    const [memberName, orgName] = await Promise.all([
      findMemberNameInOrg(input.memberId, context.activeOrganizationId),
      findOrgName(context.activeOrganizationId),
    ]);

    if (memberName !== undefined) {
      dispatchMemberEventNotification(rlog, context.activeOrganizationId, {
        type: NotificationType.member_role_changed,
        eventType: "role_changed",
        role: input.role,
        memberName,
        orgName: orgName ?? "",
      });
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
  .errors({ NOT_FOUND: {} })
  .handler(async ({ input, context, errors }) => {
    const invitation = await findInvitationInOrg(input.invitationId, context.activeOrganizationId);
    if (!invitation) {
      throw errors.NOT_FOUND({ message: "Invitation not found" });
    }

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
    const rlog = log.child({ traceId: context.traceId });
    rlog.info({ organizationId: context.activeOrganizationId }, "Deleting organization");
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

type MemberEventNotification = {
  type: NotificationType;
  eventType: "removed" | "role_changed";
  role: string;
  memberName: string;
  orgName: string;
};

function dispatchMemberEventNotification(
  rlog: { error: (obj: object, msg: string) => void },
  organizationId: string,
  spec: MemberEventNotification,
): void {
  const eventLabel = spec.eventType.replace(/_/g, " ");
  void notifyOrgMembers({
    type: spec.type,
    organizationId,
    data: {
      memberName: spec.memberName,
      eventType: spec.eventType,
      role: spec.role,
      orgName: spec.orgName,
      dashboardUrl: `${serverEnv.ORIGIN}/organizations`,
    },
  }).catch((err: unknown) => rlog.error({ err }, `Failed to send member ${eventLabel} notification`));
}

async function findInvitationInOrg(invitationId: string, organizationId: string): Promise<{ id: string } | null> {
  const [row] = await getDB()
    .select({ id: invitationT.id })
    .from(invitationT)
    .where(and(
      eq(invitationT.id, invitationId),
      eq(invitationT.organizationId, organizationId),
    ))
    .limit(1);
  return row ?? null;
}

async function findMemberNameInOrg(memberId: string, organizationId: string): Promise<string | undefined> {
  const [row] = await getDB()
    .select({ name: userT.name })
    .from(memberT)
    .innerJoin(userT, eq(userT.id, memberT.userId))
    .where(and(
      eq(memberT.id, memberId),
      eq(memberT.organizationId, organizationId),
    ))
    .limit(1);
  return row?.name;
}