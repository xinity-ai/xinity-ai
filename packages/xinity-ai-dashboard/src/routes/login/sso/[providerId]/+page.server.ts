import type { PageServerLoad } from "./$types";
import { getDB } from "$lib/server/db";
import { ssoProviderT, sql } from "common-db";
import { isAccountNotLinked } from "../../friendly-error";
import { providerEmailDomains } from "$lib/server/lib/auth/sso-domains";
import { safeCallbackPath } from "../../callback-url";

export const load: PageServerLoad = async ({ params, url }) => {
  const callbackUrl = safeCallbackPath(url.searchParams.get("callbackUrl"));
  if (!isAccountNotLinked(url.searchParams.get("error") ?? undefined)) {
    return { callbackUrl, providerDomains: [] };
  }

  const [provider] = await getDB()
    .select({ domain: ssoProviderT.domain })
    .from(ssoProviderT)
    .where(sql`${ssoProviderT.providerId} = ${params.providerId}`)
    .limit(1);

  return { callbackUrl, providerDomains: providerEmailDomains(provider?.domain ?? "") };
};
