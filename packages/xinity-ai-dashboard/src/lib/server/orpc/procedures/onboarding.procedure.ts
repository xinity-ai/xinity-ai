import { rootOs, withAuth } from "../root";
import { z } from "zod";
import { call } from "@orpc/server";
import { createOrganization } from "./organization.procedure";
import { createApiKey } from "./api-key.procedure";
import { createDeployment } from "./deployment.procedure";
import { rootLogger } from "$lib/server/logging";
import { auth, getGreenlitCallId } from "$lib/server/auth-server";
import { serverEnv, isInstanceAdmin } from "$lib/server/serverenv";
import { getDB } from "$lib/server/db";
import { userT, organizationT, memberT, eq } from "common-db";
import { slugify } from "$lib/util";

const log = rootLogger.child({ name: "onboarding.procedure" });

async function assertSlugAvailable(slug: string, errors: { CONFLICT: (opts: { message: string }) => Error }): Promise<void> {
  const existing = await getDB().select({ id: organizationT.id }).from(organizationT).where(eq(organizationT.slug, slug)).limit(1);
  if (existing.length > 0) {
    throw errors.CONFLICT({ message: "An organization with this name already exists. Please choose a different name." });
  }
}

async function markEmailVerified(userId: string): Promise<void> {
  await getDB().update(userT).set({ emailVerified: true }).where(eq(userT.id, userId));
}

async function createOrgWithOwnerMembership(
  orgName: string,
  ownerUserId: string,
  errors: { CONFLICT: (opts: { message: string }) => Error },
): Promise<{ orgId: string; orgSlug: string }> {
  const slug = slugify(orgName);
  await assertSlugAvailable(slug, errors);
  const orgId = crypto.randomUUID();
  const db = getDB();
  await db.insert(organizationT).values({ id: orgId, name: orgName, slug });
  await db.insert(memberT).values({
    id: crypto.randomUUID(),
    userId: ownerUserId,
    organizationId: orgId,
    role: "owner",
  });
  return { orgId, orgSlug: slug };
}

async function issueServerSideDashboardApiKey(userId: string, organizationId: string) {
  return await auth.api.createApiKey({
    query: { greenlitCallId: getGreenlitCallId() },
    body: {
      name: "Xinity CLI",
      userId,
      metadata: { organizationId },
    },
  });
}

const setupOnboarding = rootOs
  .meta({ mcp: false })
  .use(withAuth)
  .route({ path: "/onboarding/setup", method: "POST", tags: ["Onboarding"], summary: "Complete onboarding setup" })
  .input(z.object({
    orgName: z.string().min(1).describe("Name of the organization to create"),
    specifier: z.string().describe("The canonical model identifier"),
    modelSpecifier: z.string().describe("The driver-specific provider model string"),
    publicSpecifier: z.string().describe("The public-facing model name"),
  }))
  .output(z.object({
    apiKey: z.string().describe("The full API key (shown once)"),
    applicationName: z.string(),
    deploymentName: z.string(),
  }))
  .errors({ CONFLICT: {} })
  .handler(async ({ input, context, errors }) => {
    const rlog = log.child({ traceId: context.traceId });
    rlog.info({ orgName: input.orgName, model: input.modelSpecifier }, "Running onboarding setup");

    const slug = slugify(input.orgName);
    await assertSlugAvailable(slug, errors);

    const defaultApplicationName = "Default";

    await call(createOrganization, {
      name: input.orgName,
      slug,
    }, { context });

    const apiKeyResult = await call(createApiKey, {
      name: "Default API Key",
      enabled: true,
      createApplication: {
        name: defaultApplicationName,
        description: "Default application created during onboarding",
      },
    }, { context });

    await call(createDeployment, {
      name: input.publicSpecifier,
      specifier: input.specifier,
      modelSpecifier: input.modelSpecifier,
      publicSpecifier: input.publicSpecifier,
      enabled: true,
      replicas: 1,
    }, { context });

    return {
      apiKey: apiKeyResult.fullKey,
      applicationName: defaultApplicationName,
      deploymentName: input.publicSpecifier,
    };
  });

/**
 * Full CLI onboarding: creates a user, organization, and dashboard API key in one step.
 * Does NOT require authentication; this is the entry point for first-time CLI setup.
 */
const cli = rootOs
  .meta({ mcp: false })
  .route({
    path: "/cli",
    method: "POST",
    tags: ["Onboarding"],
    summary: "Full CLI onboarding: user + org + dashboard API key",
    description: "Unauthenticated endpoint for first-time CLI setup. Creates a user, marks email as verified, creates an organization with owner membership, and returns a dashboard API key.",
  })
  .input(z.object({
    name: z.string().min(1).describe("User display name"),
    email: z.email().describe("User email address"),
    password: z.string().min(8).describe("User password"),
    orgName: z.string().min(1).describe("Organization name"),
  }))
  .output(z.object({
    dashboardApiKey: z.string().describe("Dashboard API key for CLI authentication (shown once)"),
    userId: z.string(),
    orgId: z.string(),
    orgSlug: z.string(),
  }))
  .errors({ FORBIDDEN: {}, CONFLICT: {} })
  .handler(async ({ input, context, errors }) => {
    const rlog = log.child({ traceId: context.traceId });
    if (!serverEnv.SIGNUP_ENABLED) {
      throw errors.FORBIDDEN({ message: "User signup is currently disabled" });
    }

    if (!serverEnv.MULTI_TENANT_MODE && !isInstanceAdmin(input.email)) {
      throw errors.FORBIDDEN({
        message: "Only instance admins can create organizations. Use an email listed in INSTANCE_ADMIN_EMAILS.",
      });
    }

    // 1. Create user via Better Auth
    let signupResult: { user: { id: string } };
    try {
      signupResult = await auth.api.signUpEmail({
        body: { email: input.email, password: input.password, name: input.name },
      });
    } catch (err) {
      rlog.error({ err }, "CLI onboarding signup failed");
      throw errors.CONFLICT({ message: "Failed to create user, email may already be in use" });
    }

    const userId = signupResult.user.id;
    rlog.info({ userId, email: input.email }, "CLI onboarding: user created");

    await markEmailVerified(userId);
    const { orgId, orgSlug } = await createOrgWithOwnerMembership(input.orgName, userId, errors);
    rlog.info({ userId, orgId, orgSlug }, "CLI onboarding: organization created");

    const apiKeyResult = await issueServerSideDashboardApiKey(userId, orgId);
    rlog.info({ userId }, "CLI onboarding: dashboard API key created");

    return {
      dashboardApiKey: apiKeyResult.key,
      userId,
      orgId,
      orgSlug,
    };
  });

export const onboardingRouter = rootOs.prefix("/onboarding").router({
  setup: setupOnboarding,
  cli,
});
