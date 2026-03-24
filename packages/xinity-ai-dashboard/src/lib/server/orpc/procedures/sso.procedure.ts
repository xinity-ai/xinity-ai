/**
 * ORPC procedures for SSO provider management.
 * Supports both organization-scoped (multi-tenant) and instance-wide (single-tenant) providers.
 */
import { rootOs, withAuth } from "../root";
import { z } from "zod";
import { auth } from "$lib/server/auth-server";
import { rootLogger } from "$lib/server/logging";
import { isInstanceAdmin } from "$lib/server/serverenv";
import { getDB } from "$lib/server/db";
import { ssoProviderT, organizationT, sql, eq } from "common-db";
import { hasFeature } from "$lib/server/license";

const log = rootLogger.child({ name: "sso.procedure" });
const tags = ["SSO"];

/**
 * Authorize an SSO operation.
 * - Instance-wide SSO (no organizationId): instance admin required.
 * - Organization SSO: instance admin can always manage; org owner/admin
 *   can manage only if the org has ssoSelfManage enabled.
 */
async function requireSsoAccess(
  email: string | undefined | null,
  organizationId: string | undefined | null,
  headers: Headers,
  errors: { FORBIDDEN: (opts?: { message?: string }) => Error; NOT_FOUND: (opts?: { message?: string }) => Error },
): Promise<void> {
  // License gate: SSO requires enterprise license
  if (!hasFeature("sso")) {
    throw errors.FORBIDDEN({ message: "SSO requires an Enterprise license. Upgrade at xinity.ai/pricing." });
  }

  // License gate: org-level SSO self-management requires the feature
  if (organizationId && !hasFeature("sso-self-manage")) {
    // Allow instance admins to manage org SSO even without sso-self-manage
    if (!isInstanceAdmin(email)) {
      throw errors.FORBIDDEN({ message: "Organization SSO self-management requires an Enterprise license with SSO self-manage enabled." });
    }
  }

  if (!organizationId) {
    if (!isInstanceAdmin(email)) {
      throw errors.FORBIDDEN({ message: "Instance admin required" });
    }
    return;
  }

  // Instance admin can manage SSO for any org
  if (isInstanceAdmin(email)) return;

  // Org-level: check that the org allows self-management
  const [org] = await getDB()
    .select({ ssoSelfManage: organizationT.ssoSelfManage })
    .from(organizationT)
    .where(eq(organizationT.id, organizationId));
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
    if (!input.organizationId) {
      return getDB().select().from(ssoProviderT).where(sql`${ssoProviderT.organizationId} IS NULL`);
    }
    return getDB().select().from(ssoProviderT).where(eq(ssoProviderT.organizationId, input.organizationId));
  });

const registerOidc = rootOs
  .meta({ mcp: false })
  .use(withAuth)
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

    const result = await auth.api.registerSSOProvider({
      body: {
        providerId: input.providerId,
        issuer: input.issuer,
        domain: input.domain,
        organizationId: input.organizationId,
        oidcConfig: input.oidcConfig,
      },
      headers: context.request.headers,
    });

    log.info({ providerId: input.providerId, organizationId: input.organizationId }, "OIDC provider registered");
    return result;
  });

const registerSaml = rootOs
  .meta({ mcp: false })
  .use(withAuth)
  .route({ path: "/register-saml", method: "POST", tags, summary: "Register SAML Provider" })
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
    await requireSsoAccess(context.session.user.email, input.organizationId, context.request.headers, errors);

    const result = await auth.api.registerSSOProvider({
      body: {
        providerId: input.providerId,
        issuer: input.issuer,
        domain: input.domain,
        organizationId: input.organizationId,
        samlConfig: input.samlConfig as any,
      },
      headers: context.request.headers,
    });

    log.info({ providerId: input.providerId, organizationId: input.organizationId }, "SAML provider registered");
    return result;
  });

const deleteProvider = rootOs
  .meta({ mcp: false })
  .use(withAuth)
  .route({ path: "/", method: "DELETE", tags, summary: "Delete SSO Provider" })
  .input(z.object({
    providerId: z.string(),
  }))
  .handler(async ({ input, context, errors }) => {
    const [provider] = await getDB().select().from(ssoProviderT).where(eq(ssoProviderT.providerId, input.providerId));
    if (!provider) {
      throw errors.NOT_FOUND({ message: "Provider not found" });
    }

    await requireSsoAccess(context.session.user.email, provider.organizationId, context.request.headers, errors);

    await getDB().delete(ssoProviderT).where(eq(ssoProviderT.providerId, input.providerId));
    log.info({ providerId: input.providerId }, "SSO provider deleted");
    return { success: true };
  });

export const ssoRouter = rootOs.prefix("/sso").router({
  listProviders,
  registerOidc,
  registerSaml,
  delete: deleteProvider,
});
