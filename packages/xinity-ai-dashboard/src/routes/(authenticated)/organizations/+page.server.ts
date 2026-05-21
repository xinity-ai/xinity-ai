import type { PageServerLoad } from "./$types";
import { auth } from "$lib/server/auth-server";

export const load: PageServerLoad = async ({ request, parent }) => {
  const [organizations, allInvites, { session }] = await Promise.all([
    auth.api.listOrganizations({ headers: request.headers }),
    auth.api.listUserInvitations({ headers: request.headers }),
    parent(),
  ]);

  return {
    organizations: organizations ?? [],
    invites: allInvites.filter((invite) => invite.status === "pending"),
    activeOrganizationId: session.activeOrganizationId,
  };
};
