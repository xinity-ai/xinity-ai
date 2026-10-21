import type { PageServerLoad } from "./$types";
import { getDB } from "$lib/server/db";
import { ssoProviderT, sql } from "common-db";
import { isAccountNotLinked } from "../../friendly-error";
import { providerEmailDomains } from "$lib/server/lib/auth/sso-domains";

export const load: PageServerLoad = async ({ params, url }) => {
  if (!isAccountNotLinked(url.searchParams.get("error") ?? undefined)) {
    return { providerDomains: [] };
  }

  const [provider] = await getDB()
    .select({ domain: ssoProviderT.domain })
    .from(ssoProviderT)
    .where(sql`${ssoProviderT.providerId} = ${params.providerId}`)
    .limit(1);

  return { providerDomains: providerEmailDomains(provider?.domain ?? "") };
};
