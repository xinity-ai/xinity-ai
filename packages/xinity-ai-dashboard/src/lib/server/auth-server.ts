import { APIError, betterAuth } from "better-auth";
import { bearer, twoFactor, organization, apiKey, createAuthMiddleware } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { sso } from "@better-auth/sso";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactorT, userT, accountT, verificationT, sessionT, passkeyT, dashboardApiKeyT, ssoProviderT } from "common-db";
import { organizationT, memberT, invitationT, sql, eq, and } from "common-db";
import { rootLogger } from "./logging";
import { omit, pick } from "$lib/util";
import { serverEnv, isInstanceAdmin } from "./serverenv";
import { getDB } from "./db";
import { ac, labeler, admin, owner, member, viewer, pending } from "./roles";
import { sendEmail } from "./email";
import { notify } from "./notifications/notification.service";
import { NotificationType } from "./notifications/events";
import EmailVerificationTemplate from "$lib/components/mailTemplates/EmailVerificationTemplate.svelte";
import EmailForgotPasswordTemplate from "$lib/components/mailTemplates/EmailForgotPasswordTemplate.svelte";
import EmailInvitationTemplate from "$lib/components/mailTemplates/EmailInvitationTemplate.svelte";
import EmailEmailChangeConfirmationTemplate from "$lib/components/mailTemplates/EmailEmailChangeConfirmationTemplate.svelte";

const log = rootLogger.child({ name: "server.auth" });

// One-time tokens to allow specific server-initiated API key calls to pass through auth hooks.
const greenlitCallIds = new Set<string>();
/**
 * Generates a one-time greenlit call id for server-initiated API key actions.
 * The id is consumed by the auth middleware and then invalidated.
 */
export function getGreenlitCallId() {
  const id = crypto.randomUUID();
  greenlitCallIds.add(id);
  return id;
}

const sendWelcomeNotification = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/verify-email") return;

  const response = ctx.context?.returned as { status?: number; body?: Record<string, any> } | undefined;
  if (response?.status !== 200) return;

  const user = response.body?.user as { id?: string; name?: string } | undefined;
  if (!user?.id) return;

  log.info({ userId: user.id }, "Sending welcome notification after email verification");
  void notify({
    type: NotificationType.welcome,
    userId: user.id,
    data: {
      userName: user.name || "",
      appName: serverEnv.APP_NAME,
      appUrl: serverEnv.ORIGIN,
    },
  });
});

export const auth = betterAuth({
  appName: serverEnv.APP_NAME,
  baseURL: serverEnv.ORIGIN,
  secret: serverEnv.BETTER_AUTH_SECRET,
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh session if older than 1 day
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // cache session in cookie for 5 minutes to reduce DB lookups
    },
  },
  database: drizzleAdapter(getDB(), {
    provider: "pg", // or "mysql", "sqlite"
    schema: {
      user: userT,
      twoFactor: twoFactorT,
      session: sessionT,
      account: accountT,
      verification: verificationT,
      passkey: passkeyT,
      organization: organizationT,
      member: memberT,
      invitation: invitationT,
      apikey: dashboardApiKeyT,
      ssoProvider: ssoProviderT,
    },
  }),
  user: {
    changeEmail: {
      enabled: false,
      async sendChangeEmailVerification({ user, newEmail, url, token }, request) {
        log.info({ url, newEmail, user: pick(user, "email", "id") }, "Send change email");
        void sendEmail({
          to: user.email,
          subject: "Confirm your email change",
          template: EmailEmailChangeConfirmationTemplate,
          props: { url, newEmail, appName: serverEnv.APP_NAME, preferencesUrl: `${serverEnv.ORIGIN}/settings/notifications/` },
        });
      },
    }
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    revokeSessionsOnPasswordReset: true,
    requireEmailVerification: !!serverEnv.MAIL_URL,
    disableSignUp: false,
    async sendResetPassword({ url, user }, request) {
      log.info({ url, user: pick(user, "email", "id") }, "Send reset password");
      void sendEmail({
        to: user.email,
        subject: "Reset your password",
        template: EmailForgotPasswordTemplate,
        props: { url, appName: serverEnv.APP_NAME, preferencesUrl: `${serverEnv.ORIGIN}/settings/notifications/` },
      });
    },
  },
  emailVerification: {
    sendOnSignUp: !!serverEnv.MAIL_URL,
    autoSignInAfterVerification: true,
    async sendVerificationEmail({ user, url }, request) {
      log.info({ url, user: pick(user, "email", "id") }, "Send verification Email");
      void sendEmail({
        to: user.email,
        subject: "Verify your email",
        template: EmailVerificationTemplate,
        props: { url, appName: serverEnv.APP_NAME, preferencesUrl: `${serverEnv.ORIGIN}/settings/notifications/` },
      });
    },

  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.query?.greenlitCallId && greenlitCallIds.has(ctx.query.greenlitCallId)) {
        greenlitCallIds.delete(ctx.query.greenlitCallId);
        return;
      }

      // Gate signup: when SIGNUP_ENABLED is false, only allow users with pending invitations
      if (ctx.path === "/sign-up/email" && !serverEnv.SIGNUP_ENABLED) {
        const email = ctx.body?.email;
        if (email) {
          const [invitation] = await getDB()
            .select({ id: invitationT.id })
            .from(invitationT)
            .where(and(
              eq(invitationT.email, email),
              eq(invitationT.status, "pending"),
            ))
            .limit(1);
          if (!invitation) {
            throw new APIError("FORBIDDEN", {
              message: "Registration is currently invite-only. Contact an administrator for an invitation.",
            });
          }
          log.info({ email }, "Allowing invited user to sign up in invite-only mode");
        }
      }

      if (ctx.path === "/api-key/update" && ctx.body && "metadata" in ctx.body) {
        throw new APIError("BAD_REQUEST", {
          message: "Updating API key metadata is not allowed.",
        });
      }

      // Optional: also prevent users from setting orgId on create
      if (ctx.path === "/api-key/create") {
        throw new APIError("BAD_REQUEST", {
          message: "API Key Creation only Serverside.",
        });
      }
    }),
    after: sendWelcomeNotification,
  },
  trustedOrigins: serverEnv.NODE_ENV === "development" ? ["*"] : [
    serverEnv.ORIGIN,
    "*.google.com",
    ...(serverEnv.TRUSTED_ORIGINS?.split(",").map(s => s.trim()).filter(Boolean) ?? []),
  ],

  plugins: [
    twoFactor(),
    passkey({
      rpName: "Xinity",
      origin: serverEnv.ORIGIN,
      rpID: new URL(serverEnv.ORIGIN).hostname,
    }),
    bearer(),
    apiKey({
      rateLimit: { enabled: false },
      enableMetadata: true,
      enableSessionForAPIKeys: true,
    }),
    sso({
      organizationProvisioning: {
        defaultRole: "pending" as "member",
      },
      defaultOverrideUserInfo: true,
    }),
    organization({
      allowUserToCreateOrganization: (user) => serverEnv.MULTI_TENANT_MODE || isInstanceAdmin(user.email),
      ac,
      roles: {
        owner,
        admin,
        member,
        labeler,
        viewer,
        pending,
      },
      cancelPendingInvitationsOnReInvite: true,
      requireEmailVerificationOnInvitation: true,
      // disableOrganizationDeletion: true,
      async sendInvitationEmail(data, request) {
        const encodedEmail = encodeURIComponent(data.email);
        const url = `${serverEnv.ORIGIN}/organizations/accept-invitation-${data.invitation.id}?email=${encodedEmail}`
        log.info({ data, request, url }, "Send invitation email");
        void sendEmail({
          to: data.email,
          subject: `You've been invited to join ${data.organization.name}`,
          template: EmailInvitationTemplate,
          props: {
            url,
            inviterName: data.inviter.user.name || data.inviter.user.email,
            orgName: data.organization.name,
            loginUrl: `${serverEnv.ORIGIN}/login?email=${encodedEmail}&tab=signup`,
            appName: serverEnv.APP_NAME,
            preferencesUrl: `${serverEnv.ORIGIN}/settings/notifications/`,
          },
        });
      },
    }),
  ],
});

log.info(omit(auth.options,"plugins"), "Starting with better-auth options")

export type Session = typeof auth.$Infer.Session;
