import type { PageServerLoad } from "./$types";
import { auth } from "$lib/server/auth-server";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "organizations.page" });

export const load: PageServerLoad = async ({ request, parent }) => {
  const [organizations, invites, { session }] = await Promise.all([
    auth.api.listOrganizations({ headers: request.headers }),
    listPendingInvitations(request.headers),
    parent(),
  ]);

  return {
    organizations: organizations ?? [],
    invites,
    activeOrganizationId: session.activeOrganizationId,
  };
};

/**
 * Lists the session user's pending invitations, falling back to an empty list
 * on failure.
 */
async function listPendingInvitations(headers: Headers) {
  try {
    const invites = await auth.api.listUserInvitations({ headers });
    return invites.filter((invite) => invite.status === "pending");
  } catch (err) {
    log.warn({ err }, "Failed to list user invitations");
    return [];
  }
}
