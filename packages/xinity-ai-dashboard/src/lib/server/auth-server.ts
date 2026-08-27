import { APIError, betterAuth } from "better-auth";
import { bearer, twoFactor, organization } from "better-auth/plugins";
import { createAuthMiddleware } from "better-auth/api";
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { sso } from "@better-auth/sso";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { getRequestEvent } from "$app/server";
import { twoFactorT, userT, accountT, verificationT, sessionT, passkeyT, dashboardApiKeyT, ssoProviderT, organizationT, memberT, invitationT, sql } from "common-db";
import { rootLogger } from "./logging";
import { omit, pick } from "$lib/util";
import { serverEnv, isInstanceAdmin, parseCsvEnvList } from "./serverenv";
import { getDB } from "./db";
import { ac, roles } from "./roles";
import { sendEmail, commonEmailProps, type AnyComponent } from "./email";
import { notify } from "./notifications/notification.service";
import { NotificationType } from "./notifications/events";
import { emitAuthAuditEvent, type AuditAction } from "./orpc/audit";
import { CLIENT_ADDRESS_HEADER, readClientAddress } from "./client-address";
import EmailVerificationTemplate from "$lib/components/mailTemplates/EmailVerificationTemplate.svelte";
import EmailForgotPasswordTemplate from "$lib/components/mailTemplates/EmailForgotPasswordTemplate.svelte";
import EmailInvitationTemplate from "$lib/components/mailTemplates/EmailInvitationTemplate.svelte";
import EmailEmailChangeConfirmationTemplate from "$lib/components/mailTemplates/EmailEmailChangeConfirmationTemplate.svelte";

const log = rootLogger.child({ name: "server.auth" });

function dispatchAuthEmail(args: {
  user: { email: string; id: string };
  url: string;
  logLabel: string;
  subject: string;
  template: AnyComponent;
  extraProps?: Record<string, unknown>;
}): void {
  log.info({ url: args.url, user: pick(args.user, "email", "id") }, args.logLabel);
  void sendEmail({
    to: args.user.email,
    subject: args.subject,
    template: args.template,
    props: { ...commonEmailProps, url: args.url, ...args.extraProps },
  });
}

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

// Admin-initiated password resets: suppress the email and capture the token.
// The sendResetPassword callback resolves the pending promise with the token
// instead of sending an email, keyed by a one-time resetId passed via redirectTo.
const pendingAdminResets = new Map<string, (token: string) => void>();
const ADMIN_RESET_TOKEN_TIMEOUT_MS = 10_000;

/**
 * Resets a user's password via Better Auth's standard reset flow without
 * sending the reset email. Works by:
 * 1. Calling requestPasswordReset with a special redirectTo containing a resetId
 * 2. The sendResetPassword callback detects the prefix, captures the token, skips the email
 * 3. Immediately consuming the token with resetPassword to set the new password
 *
 * This preserves Better Auth's password hashing, session revocation, and
 * verification token lifecycle.
 */
export async function adminResetPassword(email: string, newPassword: string) {
  const resetId = crypto.randomUUID();
  const tokenPromise = new Promise<string>((resolve, reject) => {
    pendingAdminResets.set(resetId, resolve);
    // Safety timeout: if the callback never fires, clean up and reject
    setTimeout(() => {
      if (pendingAdminResets.delete(resetId)) {
        reject(new Error("Admin password reset timed out waiting for token"));
      }
    }, ADMIN_RESET_TOKEN_TIMEOUT_MS);
  });
  await auth.api.requestPasswordReset({
    body: { email, redirectTo: `__admin_reset__:${resetId}` },
  });
  const token = await tokenPromise;
  await auth.api.resetPassword({
    body: { newPassword, token },
  });
}

export async function adminCreateUser(
  email: string,
  name: string,
  password: string,
): Promise<{ userId: string }> {
  const ctx = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = ctx.password.config;
  if (password.length < minPasswordLength) {
    throw new Error("Password too short");
  }
  if (password.length > maxPasswordLength) {
    throw new Error("Password too long");
  }

  const normalizedEmail = email.toLowerCase();

  const existing = await ctx.internalAdapter.findUserByEmail(normalizedEmail);
  if (existing) {
    throw new Error("User already exists");
  }

  const hash = await ctx.password.hash(password);
  const user = await ctx.internalAdapter.createUser({
    email: normalizedEmail,
    name,
    emailVerified: false,
  });
  if (!user) {
    throw new Error("Failed to create user");
  }

  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: hash,
  });

  return { userId: user.id };
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

type AuthAuditPath = { action: AuditAction; recordFailure?: boolean };

const AUTH_AUDIT_PATHS: Record<string, AuthAuditPath> = {
  "/two-factor/enable": { action: "account.enable_2fa" },
  "/two-factor/disable": { action: "account.disable_2fa" },
  "/sign-in/email": { action: "account.sign_in", recordFailure: true },
  "/sign-out": { action: "account.sign_out" },
  "/sign-up/email": { action: "account.sign_up" },
  "/forgot-password": { action: "account.request_password_reset" },
  "/verify-email": { action: "account.verify_email" },
};

const AUTH_AUDIT_PREFIXES: Array<{ prefix: string; config: AuthAuditPath }> = [
  { prefix: "/sso/callback", config: { action: "account.sign_in_sso" } },
  { prefix: "/sso/saml2/callback", config: { action: "account.sign_in_sso" } },
  { prefix: "/sso/saml2/sp/acs", config: { action: "account.sign_in_sso" } },
];

function matchAuditPath(path: string): AuthAuditPath | undefined {
  const exact = AUTH_AUDIT_PATHS[path];
  if (exact) {
    return exact;
  }
  for (const { prefix, config } of AUTH_AUDIT_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + "/")) {
      return config;
    }
  }
  return undefined;
}

type UserLike = { id?: string; email?: string };

function resolveAuthUser(ctx: {
  context?: { session?: { user?: UserLike }; newSession?: { user?: UserLike } };
  body?: { email?: string };
}): { actorId: string | null; actorLabel: string | null; resourceId: string | null } {
  const sessionUser = ctx.context?.session?.user ?? ctx.context?.newSession?.user;
  if (sessionUser?.id) {
    return { actorId: sessionUser.id, actorLabel: sessionUser.email ?? null, resourceId: sessionUser.id };
  }
  const email = ctx.body?.email;
  if (typeof email === "string") {
    return { actorId: null, actorLabel: email, resourceId: null };
  }
  return { actorId: null, actorLabel: null, resourceId: null };
}

const recordAuthAudit = createAuthMiddleware(async (ctx) => {
  const config = matchAuditPath(ctx.path);
  if (!config) return;
  const response = ctx.context?.returned as { status?: number } | undefined;
  const status = response?.status;
  const isSuccess = !status || (status >= 200 && status < 300);
  if (!isSuccess && !config.recordFailure) return;
  const { actorId, actorLabel, resourceId } = resolveAuthUser(ctx as any);
  if (!actorId && !actorLabel) return;
  const headers = ctx.headers ?? ctx.request?.headers;
  emitAuthAuditEvent({
    action: config.action,
    resource: "account",
    actorId,
    actorLabel,
    ipAddress: readClientAddress(headers),
    userAgent: headers?.get("user-agent") ?? null,
    resourceId,
    result: isSuccess ? "success" : "failure",
  });
});

export const auth = betterAuth({
  appName: serverEnv.APP_NAME,
  baseURL: serverEnv.ORIGIN,
  secret: serverEnv.BETTER_AUTH_SECRET,
  rateLimit: {
    enabled: serverEnv.NODE_ENV !== "test",
  },
  advanced: {
    // Session rows and rate-limit buckets read the address the adapter already
    // resolved, so Better Auth never trusts a forwarded header on its own.
    ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
  },
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
    transaction: true,
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
      async sendChangeEmailConfirmation({ user, newEmail, url }) {
        dispatchAuthEmail({
          user, url,
          logLabel: "Send change email",
          subject: "Confirm your email change",
          template: EmailEmailChangeConfirmationTemplate,
          extraProps: { newEmail },
        });
      },
    }
  },
  account: {
    accountLinking: {
      enabled: true,
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    revokeSessionsOnPasswordReset: true,
    requireEmailVerification: !!serverEnv.MAIL_URL,
    disableSignUp: false,
    async sendResetPassword({ url, user, token }) {
      const redirectTo = new URL(url).searchParams.get("callbackURL") ?? "";
      const [, resetId] = decodeURIComponent(redirectTo).match(/^__admin_reset__:(.+)$/) ?? [];
      if (resetId) {
        const resolve = pendingAdminResets.get(resetId);
        if (resolve) {
          resolve(token);
          pendingAdminResets.delete(resetId);
        }
        return;
      }
      dispatchAuthEmail({
        user, url,
        logLabel: "Send reset password",
        subject: "Reset your password",
        template: EmailForgotPasswordTemplate,
      });
    },
  },
  emailVerification: {
    sendOnSignUp: !!serverEnv.MAIL_URL,
    autoSignInAfterVerification: true,
    async sendVerificationEmail({ user, url }) {
      dispatchAuthEmail({
        user, url,
        logLabel: "Send verification Email",
        subject: "Verify your email",
        template: EmailVerificationTemplate,
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
            .where(sql`
              ${invitationT.email} = ${email}
            AND
              ${invitationT.status} = ${"pending"}
            `)
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

      if (ctx.path === "/api-key/create") {
        throw new APIError("BAD_REQUEST", {
          message: "API key creation is only allowed server-side.",
        });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      await sendWelcomeNotification(ctx);
      await recordAuthAudit(ctx);
    }),
  },
  trustedOrigins: serverEnv.NODE_ENV === "development" ? ["*"] : [
    serverEnv.ORIGIN,
    "*.google.com",
    ...parseCsvEnvList(serverEnv.TRUSTED_ORIGINS),
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
      schema: {
        apikey: {
          fields: {
            referenceId: "userId",
          },
        },
      },
    }),
    sso({
      organizationProvisioning: {
        defaultRole: "pending" as "member",
      },
      defaultOverrideUserInfo: true,
      trustEmailVerified: true,
      domainVerification: {
        enabled: true,
        tokenPrefix: "xinity-sso",
      },
    }),
    organization({
      allowUserToCreateOrganization: (user) => serverEnv.MULTI_TENANT_MODE || isInstanceAdmin(user.email),
      ac,
      roles,
      cancelPendingInvitationsOnReInvite: true,
      requireEmailVerificationOnInvitation: !!serverEnv.MAIL_URL,
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
            ...commonEmailProps,
            url,
            inviterName: data.inviter.user.name || data.inviter.user.email,
            orgName: data.organization.name,
            loginUrl: `${serverEnv.ORIGIN}/login?email=${encodedEmail}&tab=signup`,
          },
        });
      },
    }),
    sveltekitCookies(getRequestEvent),
  ],
});

log.info(
  { ...omit(auth.options, "plugins", "secret"), secret: auth.options.secret ? "[redacted]" : "[unset]" },
  "Starting with better-auth options",
)

export type Session = typeof auth.$Infer.Session;
