import { auth } from "$lib/server/auth-server";
import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { serverEnv } from "$lib/server/serverenv";
import { getDB } from "$lib/server/db";
import { ssoProviderT, isNull } from "common-db";

export const load: PageServerLoad = async ({ request, url }) => {
  let session = await auth.api.getSession(request);
  let callbackUrl = url.searchParams.get("callbackUrl") || "/";
  if (session) {
    redirect(303, "/");
  }

  let ssoProviders: { providerId: string; domain: string }[] = [];
  if (!serverEnv.MULTI_TENANT_MODE) {
    ssoProviders = await getDB().select({
      providerId: ssoProviderT.providerId,
      domain: ssoProviderT.domain,
    }).from(ssoProviderT).where(isNull(ssoProviderT.organizationId));
  }

  return {
    auth: Boolean(session),
    callbackUrl,
    ssoProviders,
    signupEnabled: serverEnv.SIGNUP_ENABLED,
  };
};
