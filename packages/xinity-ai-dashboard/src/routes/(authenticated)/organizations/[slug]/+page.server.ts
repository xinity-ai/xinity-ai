import type { PageServerLoad } from "./$types";
import { auth } from "$lib/server/auth-server";
import { redirect } from "@sveltejs/kit";
import { memberT, organizationT, sql, eq } from "common-db";
import { getDB } from "$lib/server/db";
import type { RoleName } from "$lib/roles";

export const load: PageServerLoad = async ({ params, request, parent }) => {
  const { user, session } = await parent();
  const { slug } = params;

  // Get organization by slug
  const organizations = await auth.api.listOrganizations({
    headers: request.headers,
  });

  const organization = organizations?.find((org) => org.slug === slug);

  if (!organization) {
    throw redirect(302, "/organizations");
  }

  // Get full organization details with members
  const fullOrg = await auth.api.getFullOrganization({
    headers: request.headers,
    query: {
      organizationId: organization.id,
    },
  });
  if (!fullOrg) {
    throw redirect(302, "/organizations");
  }

  // Get pending invitations
  const invitations = await auth.api.listInvitations({
    headers: request.headers,
    query: {
      organizationId: organization.id,
    },
  });

  const [[activeMember], [orgRow]] = await Promise.all([
    getDB().select({ role: memberT.role }).from(memberT).where(sql`
      ${memberT.userId} = ${user.id}
      AND
      ${memberT.organizationId} = ${organization.id}
    `).limit(1),
    getDB().select({ ssoSelfManage: organizationT.ssoSelfManage }).from(organizationT).where(eq(organizationT.id, organization.id)).limit(1),
  ]);

  return {
    organization: fullOrg,
    invitations: invitations || [],
    currentUserRole: activeMember?.role as RoleName || null,
    ssoSelfManage: orgRow?.ssoSelfManage ?? false,
    isActiveOrganization: session.activeOrganizationId === organization.id,
  };
};
