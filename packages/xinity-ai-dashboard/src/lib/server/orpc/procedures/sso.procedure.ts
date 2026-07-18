import { rootOs, withAuth, auditMiddleware } from "../root";
import { z } from "zod";
import { auth } from "$lib/server/auth-server";
import { rootLogger } from "$lib/server/logging";
import { betterAuthErrorBody } from "$lib/server/better-auth-errors";
import { isInstanceAdmin } from "$lib/server/serverenv";
import { getDB } from "$lib/server/db";
import { ssoProviderT, organizationT, sql } from "common-db";
import { hasFeature } from "$lib/server/license";

const log = rootLogger.child({ name: "sso.procedure" });
const tags = ["SSO"];

async function requireSsoAccess(
  email: string | undefined | null,
  organizationId: string | undefined | null,
  headers: Headers,
  errors: { FORBIDDEN: (opts?: { message?: string }) => Error; NOT_FOUND: (opts?: { message?: string }) => Error },
): Promise<void> {
  // License gate: SSO requires enterprise license
  if (!hasFeature("sso")) {
    throw errors.FORBIDDEN({ message: "SSO requires an Enterprise license. Upgrade at xinity.ai/xinity-pricing." });
  }

  const userIsInstanceAdmin = isInstanceAdmin(email);

  // License gate: org-level SSO self-management requires the feature
  if (organizationId && !hasFeature("sso-self-manage")) {
    // Allow instance admins to manage org SSO even without sso-self-manage
    if (!userIsInstanceAdmin) {
      throw errors.FORBIDDEN({ message: "Organization SSO self-management requires an Enterprise license with SSO self-manage enabled." });
    }
  }

  if (!organizationId) {
    if (!userIsInstanceAdmin) {
      throw errors.FORBIDDEN({ message: "Instance admin required" });
    }
    return;
  }

  // Instance admin can manage SSO for any org
  if (userIsInstanceAdmin) return;

  // Org-level: check that the org allows self-management
  const [org] = await getDB()
    .select({ ssoSelfManage: organizationT.ssoSelfManage })
    .from(organizationT)
    .where(sql`${organizationT.id} = ${organizationId}`)
    .limit(1);
  if (!org) {
    throw errors.NOT_FOUND({ message: "Organization not found" });
  }
  if (!org.ssoSelfManage) {
    throw errors.FORBIDDEN({ message: "This organization is not allowed to manage its own SSO. Contact an instance admin." });
  }

  const permResult = await auth.api.hasPermission({
    headers,
    body: {
      permissions: { organization: ["update"] },
      organizationId,
    },
  });
  if (!permResult.success) {
    throw errors.FORBIDDEN({ message: "You do not have permission to manage SSO for this organization" });
  }
}

const listProviders = rootOs
  .use(withAuth)
  .route({ path: "/", method: "GET", tags, summary: "List SSO Providers" })
  .input(z.object({
    organizationId: z.string().optional(),
  }))
  .handler(async ({ input, context, errors }) => {
    await requireSsoAccess(context.session.user.email, input.organizationId, context.request.headers, errors);
    const scope = input.organizationId
      ? sql`${ssoProviderT.organizationId} = ${input.organizationId}`
      : sql`${ssoProviderT.organizationId} IS NULL`;
    const providers = await getDB().select().from(ssoProviderT).where(scope);

    const enriched = await Promise.all(providers.map(async (provider) => {
      if (provider.domainVerified) {
        return { ...provider, verification: null };
      }
      try {
        const result = await auth.api.requestDomainVerification({
          body: { providerId: provider.providerId },
          headers: context.request.headers,
        });
        const hostname = domainToHostname(provider.domain);
        const { txtRecord, txtValue } = formatTxtRecord(provider.providerId, hostname);
        return {
          ...provider,
          verification: {
            txtRecord,
            txtValue: `${txtValue}=${result.domainVerificationToken}`,
          },
        };
      } catch {
        return { ...provider, verification: null };
      }
    }));

    return enriched;
  });

type BetterAuthErrorHandlers = {
  BAD_REQUEST: (opts?: { message?: string }) => Error;
  INTERNAL_SERVER_ERROR: (opts?: { message?: string }) => Error;
};

function rethrowBetterAuthError(
  err: unknown,
  fallbackMessage: string,
  errors: BetterAuthErrorHandlers,
): never {
  const body = betterAuthErrorBody(err);
  if (body) {
    throw errors.BAD_REQUEST({ message: body.message ?? fallbackMessage });
  }
  throw errors.INTERNAL_SERVER_ERROR({
    message: err instanceof Error ? err.message : fallbackMessage,
  });
}

function formatTxtRecord(providerId: string, hostname: string) {
  return {
    txtRecord: `_xinity-sso-${providerId}.${hostname}`,
    txtValue: `_xinity-sso-${providerId}`,
  };
}

async function dispatchSsoRegistration(
  input: { providerId: string; issuer: string; domain: string; organizationId?: string },
  config: { oidcConfig?: unknown } | { samlConfig?: unknown },
  context: { request: Request; traceId?: string },
  kind: "OIDC" | "SAML",
  errors: BetterAuthErrorHandlers,
) {
  const rlog = log.child({ traceId: context.traceId });
  try {
    const result = await auth.api.registerSSOProvider({
      body: {
        providerId: input.providerId,
        issuer: input.issuer,
        domain: input.domain,
        organizationId: input.organizationId,
        ...config,
      } as any,
      headers: context.request.headers,
    });
    rlog.info({ providerId: input.providerId, organizationId: input.organizationId }, `${kind} provider registered`);
    return result;
  } catch (err) {
    rethrowBetterAuthError(err, "SSO provider registration failed", errors);
  }
}

const registerOidc = rootOs
  .meta({ mcp: false, audit: { action: "sso.register_oidc", resource: "sso", resourceId: { fromInput: "providerId" }, captureInput: ["domain"] } })
  .use(withAuth)
  .use(auditMiddleware)
  .errors({ BAD_REQUEST: {} })
  .route({ path: "/register-oidc", method: "POST", tags, summary: "Register OIDC Provider" })
  .input(z.object({
    organizationId: z.string().optional(),
    providerId: z.string(),
    issuer: z.string(),
    domain: z.string(),
    oidcConfig: z.object({
      clientId: z.string(),
      clientSecret: z.string(),
      scopes: z.array(z.string()).optional(),
      pkce: z.boolean().optional(),
      discoveryEndpoint: z.string().optional(),
      tokenEndpointAuthentication: z.enum(["client_secret_basic", "client_secret_post"]).optional(),
      authorizationEndpoint: z.string().optional(),
      tokenEndpoint: z.string().optional(),
      jwksEndpoint: z.string().optional(),
      userInfoEndpoint: z.string().optional(),
    }),
  }))
  .handler(async ({ input, context, errors }) => {
    await requireSsoAccess(context.session.user.email, input.organizationId, context.request.headers, errors);
    return dispatchSsoRegistration(input, { oidcConfig: input.oidcConfig }, context, "OIDC", errors);
  });

const registerSaml = rootOs
  .meta({ mcp: false, audit: { action: "sso.register_saml", resource: "sso", resourceId: { fromInput: "providerId" }, captureInput: ["domain"] } })
  .use(withAuth)
  .use(auditMiddleware)
  .errors({ BAD_REQUEST: {}, FORBIDDEN: {} })
  .route({ path: "/register-saml", method: "POST", tags: [...tags, ".internal"], summary: "Register SAML Provider (dev only)" })
  .input(z.object({
    organizationId: z.string().optional(),
    providerId: z.string(),
    issuer: z.string(),
    domain: z.string(),
    samlConfig: z.object({
      entryPoint: z.string(),
      cert: z.string(),
      callbackUrl: z.string(),
      audience: z.string().optional(),
      idpMetadata: z.object({ metadata: z.string().optional() }).optional(),
      spMetadata: z.object({
        metadata: z.string().optional(),
        entityID: z.string().optional(),
        binding: z.string().optional(),
      }).default({}),
      wantAssertionsSigned: z.boolean().optional(),
      signatureAlgorithm: z.string().optional(),
      digestAlgorithm: z.string().optional(),
      identifierFormat: z.string().optional(),
    }),
  }))
  .handler(async ({ input, context, errors }) => {
    if (process.env.NODE_ENV === "production") {
      throw errors.FORBIDDEN({ message: "SAML provider registration is not available" });
    }
    await requireSsoAccess(context.session.user.email, input.organizationId, context.request.headers, errors);
    return dispatchSsoRegistration(input, { samlConfig: input.samlConfig }, context, "SAML", errors);
  });

async function findProviderOrThrow(
  providerId: string,
  errors: { NOT_FOUND: (opts?: { message?: string }) => Error },
) {
  const [provider] = await getDB()
    .select()
    .from(ssoProviderT)
    .where(sql`${ssoProviderT.providerId} = ${providerId}`)
    .limit(1);
  if (!provider) {
    throw errors.NOT_FOUND({ message: "Provider not found" });
  }
  return provider;
}

function domainToHostname(domain: string): string {
  try {
    return new URL(domain.includes("://") ? domain : `https://${domain}`).hostname;
  } catch {
    return domain;
  }
}

const requestDomainVerification = rootOs
  .meta({ mcp: false })
  .use(withAuth)
  .route({ path: "/request-domain-verification", method: "POST", tags, summary: "Request domain verification" })
  .input(z.object({ providerId: z.string() }))
  .handler(async ({ input, context, errors }) => {
    const provider = await findProviderOrThrow(input.providerId, errors);
    await requireSsoAccess(context.session.user.email, provider.organizationId, context.request.headers, errors);

    try {
      const result = await auth.api.requestDomainVerification({
        body: { providerId: input.providerId },
        headers: context.request.headers,
      });

      const hostname = domainToHostname(provider.domain);
      const { txtRecord, txtValue } = formatTxtRecord(input.providerId, hostname);
      return {
        token: result.domainVerificationToken,
        txtRecord,
        txtValue: `${txtValue}=${result.domainVerificationToken}`,
      };
    } catch (err) {
      rethrowBetterAuthError(err, "Failed to request domain verification", errors);
    }
  });

const verifyDomain = rootOs
  .meta({ mcp: false })
  .use(withAuth)
  .route({ path: "/verify-domain", method: "POST", tags, summary: "Verify domain ownership" })
  .input(z.object({ providerId: z.string() }))
  .handler(async ({ input, context, errors }) => {
    const provider = await findProviderOrThrow(input.providerId, errors);
    await requireSsoAccess(context.session.user.email, provider.organizationId, context.request.headers, errors);

    try {
      await auth.api.verifyDomain({
        body: { providerId: input.providerId },
        headers: context.request.headers,
      });
    } catch (err) {
      rethrowBetterAuthError(err, "Domain verification failed", errors);
    }

    log.info({ providerId: input.providerId, traceId: context.traceId }, "Domain verified");
    return { success: true }
  });

const deleteProvider = rootOs
  .meta({ mcp: false, audit: { action: "sso.delete_provider", resource: "sso", resourceId: { fromInput: "providerId" } } })
  .use(withAuth)
  .use(auditMiddleware)
  .route({ path: "/", method: "DELETE", tags, summary: "Delete SSO Provider" })
  .input(z.object({
    providerId: z.string(),
  }))
  .handler(async ({ input, context, errors }) => {
    const provider = await findProviderOrThrow(input.providerId, errors);
    await requireSsoAccess(context.session.user.email, provider.organizationId, context.request.headers, errors);

    await getDB().delete(ssoProviderT).where(sql`${ssoProviderT.providerId} = ${input.providerId}`);
    log.info({ providerId: input.providerId, traceId: context.traceId }, "SSO provider deleted");
    return { success: true };
  });

export const ssoRouter = rootOs.prefix("/sso").router({
  listProviders,
  registerOidc,
  registerSaml,
  requestDomainVerification,
  verifyDomain,
  delete: deleteProvider,
});
