import { describe, test } from "bun:test";
import { betterAuth } from "better-auth";
import { bearer, twoFactor, organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { sso } from "@better-auth/sso";

// Mirrors the endpoint-relevant options of auth-server.ts. A plugin added there belongs here too.
const auth = betterAuth({
  secret: "test-better-auth-secret",
  baseURL: "http://localhost:5173",
  emailAndPassword: { enabled: true },
  plugins: [
    twoFactor(),
    passkey(),
    bearer(),
    apiKey(),
    sso({ domainVerification: { enabled: true } }),
    organization(),
  ],
});

const KNOWN_ENDPOINTS = [
  "/account-info",
  "/api-key/create",
  "/api-key/delete",
  "/api-key/get",
  "/api-key/list",
  "/api-key/update",
  "/callback/:id",
  "/change-email",
  "/change-password",
  "/delete-user",
  "/delete-user/callback",
  "/error",
  "/get-access-token",
  "/get-session",
  "/link-social",
  "/list-accounts",
  "/list-sessions",
  "/ok",
  "/organization/accept-invitation",
  "/organization/cancel-invitation",
  "/organization/check-slug",
  "/organization/create",
  "/organization/delete",
  "/organization/get-active-member",
  "/organization/get-active-member-role",
  "/organization/get-full-organization",
  "/organization/get-invitation",
  "/organization/get-organization",
  "/organization/has-permission",
  "/organization/invite-member",
  "/organization/leave",
  "/organization/list",
  "/organization/list-invitations",
  "/organization/list-members",
  "/organization/list-user-invitations",
  "/organization/reject-invitation",
  "/organization/remove-member",
  "/organization/set-active",
  "/organization/update",
  "/organization/update-member-role",
  "/passkey/delete-passkey",
  "/passkey/generate-authenticate-options",
  "/passkey/generate-register-options",
  "/passkey/list-user-passkeys",
  "/passkey/update-passkey",
  "/passkey/verify-authentication",
  "/passkey/verify-registration",
  "/refresh-token",
  "/request-password-reset",
  "/reset-password",
  "/reset-password/:token",
  "/revoke-other-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/send-verification-email",
  "/sign-in/email",
  "/sign-in/social",
  "/sign-in/sso",
  "/sign-out",
  "/sign-up/email",
  "/sso/callback",
  "/sso/callback/:providerId",
  "/sso/delete-provider",
  "/sso/get-provider",
  "/sso/providers",
  "/sso/register",
  "/sso/request-domain-verification",
  "/sso/saml2/logout/:providerId",
  "/sso/saml2/sp/acs/:providerId",
  "/sso/saml2/sp/metadata",
  "/sso/saml2/sp/slo/:providerId",
  "/sso/update-provider",
  "/sso/verify-domain",
  "/two-factor/disable",
  "/two-factor/enable",
  "/two-factor/generate-backup-codes",
  "/two-factor/get-totp-uri",
  "/two-factor/send-otp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
  "/two-factor/verify-totp",
  "/unlink-account",
  "/update-session",
  "/update-user",
  "/verify-email",
  "/verify-password",
];

describe("Better Auth endpoint surface", () => {
  test("matches the set reviewed against internalSigninPaths in auth-server.ts", () => {
    const actual = new Set(
      Object.values(auth.api)
        .map((endpoint) => (endpoint as { path?: string }).path)
        .filter((path): path is string => typeof path === "string"),
    );
    const known = new Set(KNOWN_ENDPOINTS);
    const added = [...actual].filter((path) => !known.has(path)).sort();
    const removed = [...known].filter((path) => !actual.has(path)).sort();
    if (added.length > 0 || removed.length > 0) {
      throw new Error(
        "Better Auth's endpoints changed. Check every added path against internalSigninPaths and "
        + "internalSigninPathPrefixes in src/lib/server/auth-server.ts, then update KNOWN_ENDPOINTS.\n"
        + `Added: ${JSON.stringify(added)}\nRemoved: ${JSON.stringify(removed)}`,
      );
    }
  });
});
