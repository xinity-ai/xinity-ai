import { error } from "@sveltejs/kit";
import { auth, type Session } from "$lib/server/auth-server";
import { hasFeature } from "$lib/server/license";

/**
 * Auth guard for compliance SvelteKit routes (file upload/download), which
 * bypass the oRPC middleware chain and must replicate its checks manually:
 * session, active organization, compliance-reports license, RBAC.
 */
export async function requireComplianceAccess(
  request: Request,
  action: "read" | "update",
): Promise<{ session: Session; organizationId: string }> {
  const session = await auth.api.getSession(request);
  if (!session) error(401, "Unauthorized");

  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) error(403, "No active organization");

  if (!hasFeature("compliance-reports")) {
    error(403, "Compliance reports require a license with the compliance-reports feature. Upgrade at xinity.ai/xinity-pricing.");
  }

  const result = await auth.api.hasPermission({
    headers: request.headers,
    body: { permissions: { compliance: [action] }, organizationId },
  });
  if (!result.success) error(403, "Forbidden");

  return { session, organizationId };
}
