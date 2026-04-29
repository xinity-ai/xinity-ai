import { createAuthClient } from "better-auth/svelte";
import { twoFactorClient, organizationClient } from "better-auth/client/plugins";
import { apiKeyClient } from "@better-auth/api-key/client";
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
