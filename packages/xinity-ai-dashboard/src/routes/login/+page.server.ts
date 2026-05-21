import { auth } from "$lib/server/auth-server";
import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { serverEnv } from "$lib/server/serverenv";
import { getDB } from "$lib/server/db";
import { ssoProviderT, sql } from "common-db";

export const load: PageServerLoad = async ({ request, url }) => {
  const session = await auth.api.getSession(request);
  if (session) {
    redirect(303, "/");
  }

  const callbackUrl = url.searchParams.get("callbackUrl") || "/";
  const configuredOrigin = new URL(serverEnv.ORIGIN);
  const hostMismatch =
    serverEnv.NODE_ENV !== "development" && url.host !== configuredOrigin.host;

  const ssoProviders = serverEnv.MULTI_TENANT_MODE
    ? []
    : await getDB().select({
        providerId: ssoProviderT.providerId,
        domain: ssoProviderT.domain,
      }).from(ssoProviderT).where(sql`${ssoProviderT.organizationId} IS NULL`);

  return {
    callbackUrl,
    ssoProviders,
    signupEnabled: serverEnv.SIGNUP_ENABLED,
    emailVerificationRequired: Boolean(serverEnv.MAIL_URL),
    hostMismatch,
    configuredOrigin: configuredOrigin.origin,
  };
};
