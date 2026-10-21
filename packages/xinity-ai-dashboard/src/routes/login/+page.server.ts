import { auth } from "$lib/server/auth-server";
import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { config } from "$lib/server/config";
import { getDB } from "$lib/server/db";
import { ssoProviderT, sql } from "common-db";
import { safeCallbackPath } from "./callback-url";

export const load: PageServerLoad = async ({ request, url }) => {
  const callbackUrl = safeCallbackPath(url.searchParams.get("callbackUrl"));
  const session = await auth.api.getSession({ headers: request.headers });
  if (session) {
    redirect(303, callbackUrl);
  }

  const configuredOrigin = new URL(config.origin);
  const hostMismatch =
    config.nodeEnv !== "development" && url.host !== configuredOrigin.host;

  const ssoProviders = config.auth.multiTenantMode
    ? []
    : await getDB().select({
        providerId: ssoProviderT.providerId,
        domain: ssoProviderT.domain,
      }).from(ssoProviderT).where(sql`${ssoProviderT.organizationId} IS NULL`);

  return {
    callbackUrl,
    ssoProviders,
    signupEnabled: config.auth.signupEnabled(),
    emailVerificationRequired: Boolean(config.mail),
    hostMismatch,
    configuredOrigin: configuredOrigin.origin,
  };
};
