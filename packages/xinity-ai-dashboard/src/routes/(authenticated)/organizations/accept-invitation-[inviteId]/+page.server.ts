import type { PageServerLoad, Actions } from "./$types";
import { auth } from "$lib/server/auth-server";
import { fail, redirect } from "@sveltejs/kit";
import { rootLogger } from "$lib/server/logging";
import { getDB } from "$lib/server/db";
import { organizationT, sql } from "common-db";

const log = rootLogger.child({ name: "accept-invitation" });

export const load: PageServerLoad = async ({ params, request, parent }) => {
  const { user } = await parent();
  const inviteId = params.inviteId;

  let organizationSlug: string | undefined = undefined;
  try {
    const invitation = await auth.api.acceptInvitation({
      body: {
        invitationId: inviteId,
      },
      headers: request.headers,
    });
    if(invitation){
      const [organization] = await getDB().select({ slug: organizationT.slug }).from(organizationT).where(sql`
        ${organizationT.id} = ${invitation.invitation.organizationId}
      `).limit(1);
      organizationSlug = organization?.slug;
    }

  } catch (err: unknown) {
    // Handle specific error cases: Better Auth errors carry body.code, statusCode, etc.
    const e = err as Record<string, unknown> | null;
    const body = (e?.body ?? {}) as Record<string, unknown>;
    const errorCode = (body.code || e?.code) as string | undefined;
    const statusCode = (e?.statusCode || e?.status || 500) as number;
    log.error({ err }, "Error accepting invitation");

    return {
      error: true,
      errorCode,
      statusCode,
      errorMessage: (e?.message as string) || (body.message as string) || "Unknown error occurred",
      userEmail: user?.email,
      inviteId,
    };
  }
  if(organizationSlug){
    redirect(302, `/organizations/${organizationSlug}/`)
  }
  // Success - redirect to organizations
  redirect(302, "/organizations/");
};