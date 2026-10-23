import type { PageServerLoad } from "./$types";
import { auth } from "$lib/server/auth-server";
import { rootLogger } from "$lib/server/logging";
import { getDB } from "$lib/server/db";
import { organizationT, sql } from "common-db";

const log = rootLogger.child({ name: "accept-invitation" });

// Accepting happens on the page's button, not here: a GET carries the session cookie on any
// cross-site link, so a load that accepted would join users to organizations they never chose.
export const load: PageServerLoad = async ({ params, request, parent }) => {
  const { user } = await parent();
  const inviteId = params.inviteId;

  try {
    const invitation = await auth.api.getInvitation({
      query: { id: inviteId },
      headers: request.headers,
    });
    const [organization] = await getDB()
      .select({ logo: organizationT.logo })
      .from(organizationT)
      .where(sql`${organizationT.id} = ${invitation.organizationId}`)
      .limit(1);
    return {
      error: false as const,
      invitation: {
        organizationName: invitation.organizationName,
        organizationSlug: invitation.organizationSlug,
        organizationLogo: organization?.logo ?? null,
        inviterEmail: invitation.inviterEmail,
        role: invitation.role,
      },
      userEmail: user?.email,
      inviteId,
    };
  } catch (err: unknown) {
    // Handle specific error cases: Better Auth errors carry body.code, statusCode, etc.
    const e = err as Record<string, unknown> | null;
    const body = (e?.body ?? {}) as Record<string, unknown>;
    const errorCode = (body.code || e?.code) as string | undefined;
    const statusCode = (e?.statusCode || e?.status || 500) as number;
    log.error({ err }, "Error reading invitation");

    return {
      error: true as const,
      errorCode,
      statusCode,
      errorMessage: (e?.message as string) || (body.message as string) || "Unknown error occurred",
      userEmail: user?.email,
      inviteId,
    };
  }
};
