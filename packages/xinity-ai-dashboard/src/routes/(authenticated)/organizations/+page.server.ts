import type { PageServerLoad } from "./$types";
import { auth } from "$lib/server/auth-server";

export const load: PageServerLoad = async ({ request, parent }) => {
  
  const organizations = auth.api.listOrganizations({
    headers: request.headers,
  });
  const invites = auth.api.listUserInvitations({
    headers: request.headers,
  }).then((invites) => invites.filter((invite) => invite.status === "pending"));
  const activeOrganizationId = parent().then(({session})=> session.activeOrganizationId)

  return {
    organizations: await organizations || [],
    invites: (await invites),
    activeOrganizationId: (await activeOrganizationId), 
  };
};
