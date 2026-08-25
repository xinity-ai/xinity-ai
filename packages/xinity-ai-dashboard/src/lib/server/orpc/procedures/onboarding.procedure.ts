import { rootOs, withAuth, auditMiddleware } from "../root";
import { z } from "zod";
import { call } from "@orpc/server";
import { createOrganization } from "./organization.procedure";
import { createApiKey } from "./api-key.procedure";
import { createDeployment } from "./deployment.procedure";
import { rootLogger } from "$lib/server/logging";
import { auth, getGreenlitCallId, adminCreateUser } from "$lib/server/auth-server";
import { serverEnv, isInstanceAdmin } from "$lib/server/serverenv";
import { getDB } from "$lib/server/db";
import { userT, organizationT, memberT, sql } from "common-db";
import { slugify } from "$lib/util";

const log = rootLogger.child({ name: "onboarding.procedure" });

async function assertSlugAvailable(slug: string, errors: { CONFLICT: (opts: { message: string }) => Error }): Promise<void> {
  const existing = await getDB().select({ id: organizationT.id }).from(organizationT).where(sql`${organizationT.slug} = ${slug}`).limit(1);
  if (existing.length > 0) {
    throw errors.CONFLICT({ message: "An organization with this name already exists. Please choose a different name." });
  }
}

async function markEmailVerified(userId: string): Promise<void> {
  await getDB().update(userT).set({ emailVerified: true }).where(sql`${userT.id} = ${userId}`);
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
  .meta({ mcp: false, audit: { action: "onboarding.setup", resource: "onboarding", captureInput: ["orgName", "specifier"], captureOutput: ["deploymentName"] } })
  .use(withAuth)
  .use(auditMiddleware)
  .route({ path: "/onboarding/setup", method: "POST", tags: ["Onboarding"], summary: "Complete onboarding setup" })
  .input(z.object({
    orgName: z.string().min(1).describe("Name of the organization to create"),
    specifier: z.string().optional().describe("The canonical model identifier"),
    publicSpecifier: z.string().optional().describe("The public-facing model name"),
  }))
  .output(z.object({
    apiKey: z.string().describe("The full API key (shown once)"),
    applicationName: z.string(),
    deploymentName: z.string().nullable().describe("Null when onboarding created no deployment"),
    deploymentWarning: z.string().nullable().describe("Why the requested deployment was not created, if it was rejected"),
  }))
  .errors({ CONFLICT: {} })
  .handler(async ({ input, context, errors }) => {
    const rlog = log.child({ traceId: context.traceId });
    rlog.info({ orgName: input.orgName, model: input.specifier }, "Running onboarding setup");

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

    let deploymentName: string | null = null;
    let deploymentWarning: string | null = null;
    if (input.specifier) {
      const publicSpecifier = input.publicSpecifier ?? input.specifier;
      try {
        await call(createDeployment, {
          name: publicSpecifier,
          specifier: input.specifier,
          publicSpecifier,
          enabled: true,
          replicas: 1,
        }, { context });
        deploymentName = publicSpecifier;
      } catch (err) {
        // The organization and its API key already exist, and the key is only ever
        // returned here, so a rejected deployment must not take the whole setup down.
        rlog.error({ err, specifier: input.specifier }, "Onboarding deployment failed");
        deploymentWarning = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      apiKey: apiKeyResult.fullKey,
      applicationName: defaultApplicationName,
      deploymentName,
      deploymentWarning,
    };
  });

/**
 * Full CLI onboarding: creates a user, organization, and dashboard API key in one step.
 * Does NOT require authentication; this is the entry point for first-time CLI setup.
 */
const cli = rootOs
  .meta({ mcp: false, audit: { action: "onboarding.cli", resource: "user", captureInput: ["email", "orgName"] } })
  .use(auditMiddleware)
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

    let userId: string;
    try {
      ({ userId } = await adminCreateUser(input.email, input.name, input.password));
    } catch (err) {
      rlog.error({ err }, "CLI onboarding signup failed");
      throw errors.CONFLICT({ message: "Failed to create user, email may already be in use" });
    }
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
