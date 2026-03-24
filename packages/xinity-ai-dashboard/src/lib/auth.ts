import { createAuthClient } from "better-auth/svelte";
import { twoFactorClient, organizationClient, apiKeyClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { ssoClient } from "@better-auth/sso/client";
import { ac, roles } from "$lib/roles";

export const { signIn, signUp, useSession, signOut, twoFactor, passkey, organization, sso } = createAuthClient({
  plugins: [
    twoFactorClient(),
    passkeyClient(),
    organizationClient({
      ac,
      roles,
    }),
    apiKeyClient(),
    ssoClient(),
  ],
});
