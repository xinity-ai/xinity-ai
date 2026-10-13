import { organizationT } from "common-db";
import { getDB } from "$lib/server/db";
import { hasFeature } from "$lib/server/license";

export const MULTI_ORG_LICENSE_MESSAGE = "Multiple organizations require an Enterprise license. Upgrade at xinity.ai/xinity-pricing.";

export async function organizationLimitReached(): Promise<boolean> {
  if (hasFeature("multi-org")) {
    return false;
  }
  const [existingOrg] = await getDB().select({ id: organizationT.id }).from(organizationT).limit(1);
  return existingOrg !== undefined;
}
