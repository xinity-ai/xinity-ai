import { rootOs, withOrganization, requirePermission } from "../root";
import { z } from "zod";
import { ApiKeyDto } from "$lib/orpc/dtos/api-key.dto";
import { commonInputFilter } from "$lib/orpc/dtos/common.dto";
import { randomBytes } from "node:crypto";
import { and, eq, aiApiKeyT, aiApplicationT, isNull } from "common-db";
import { pick } from "$lib/util";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { recordAudit } from "$lib/server/audit";

const log = rootLogger.child({ name: "api-key.procedure" });

function generateRandomKey(length = 64) {
  return randomBytes(length).toString("base64url"); // URL-safe base64 string
}

const matchActiveApiKeyInOrg = (keyId: string, orgId: string) => and(
  eq(aiApiKeyT.id, keyId),
  eq(aiApiKeyT.organizationId, orgId),
  isNull(aiApiKeyT.deletedAt),
);

const tags = ["LLM API Key"];

export const createApiKey = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiKey: ["create"] }))
  .route({ path: "/", method: "POST", tags, summary: "Create LLM API Key" })
  .input(
    ApiKeyDto.omit({ specifier: true, id: true, applicationId: true, collectData: true, createdByUserId: true, createdByUserName: true, ...commonInputFilter }).extend({
      createApplication: z.object({
        name: z.string(),
        description: z.string().optional(),
      }).optional(),
      applicationId: z.uuid().optional(),
    })
  )
  .errors({
    CONFLICT: {},
    NOT_FOUND: {},
  })
  .handler(async ({ input, context, errors }) => {
    const rlog = log.child({ traceId: context.traceId });
    rlog.info({ keyName: input.name, org: context.activeOrganizationId }, "Creating new API key")

    let applicationId: string | null = input.applicationId ?? null;

    if (applicationId) {
      const [application] = await getDB()
        .select({ id: aiApplicationT.id })
        .from(aiApplicationT)
        .where(and(
          eq(aiApplicationT.id, applicationId),
          eq(aiApplicationT.organizationId, context.activeOrganizationId),
          isNull(aiApplicationT.deletedAt),
        ))
        .limit(1);
      if (!application) {
        throw errors.NOT_FOUND({ message: "Application not found" })
      }
    } else if (input.createApplication) {
      const [newApp] = await getDB()
        .insert(aiApplicationT)
        .values({
          name: input.createApplication.name,
          description: input.createApplication.description,
          organizationId: context.activeOrganizationId,
        })
        .returning();
      if (!newApp) throw new Error("Insert into aiApplicationT returned no row");
      applicationId = newApp.id;
    }

    const specifier = "sk_" + generateRandomKey(16);
    const secretKey = generateRandomKey();

    const fullKey = `${specifier}${secretKey}`;
    const hash = await Bun.password.hash(fullKey);
    const [created] = await getDB()
      .insert(aiApiKeyT)
      .values({
        name: input.name,
        enabled: input.enabled,
        applicationId,
        organizationId: context.activeOrganizationId,
        createdByUserId: context.session.user.id,
        specifier,
        hash: hash,
      })
      .returning({ id: aiApiKeyT.id });
    await recordAudit(context, {
      action: "apiKey.create",
      resourceType: "aiApiKey",
      resourceId: created?.id,
      details: { name: input.name, specifier, applicationId },
    });
    return {
      fullKey,
      name: input.name,
      specifier,
      applicationId,
    };
  });

const listApiKey = rootOs.use(withOrganization)
  .use(requirePermission({ apiKey: ["read"] }))
  .route({ path: "/", tags, method: "GET", summary: "List LLM API Keys" })
  .handler(async ({ context }) => {
    const keys = await getDB()
      .select(pick(aiApiKeyT, "name", "enabled", "collectData", "specifier", "createdAt", "id", "applicationId", "createdByUserId"))
      .from(aiApiKeyT)
      .where(
        and(
          eq(aiApiKeyT.organizationId, context.activeOrganizationId),
          isNull(aiApiKeyT.deletedAt)
        )
      )
      .limit(400);
    return keys;
  });

const updateApiKey = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiKey: ["update"] }))
  .route({ method: "PATCH", path: "/{id}", tags, summary: "Update LLM API Key" })
  .input(ApiKeyDto.pick({ id: true, name: true }).extend({
    applicationId: z.uuid().nullable().optional(),
  }))
  .errors({
    NOT_FOUND: {},
  })
  .handler(async ({ context, input, errors }) => {
    const set: Record<string, unknown> = { name: input.name };

    if (input.applicationId !== undefined) {
      if (input.applicationId !== null) {
        const [app] = await getDB()
          .select({ id: aiApplicationT.id })
          .from(aiApplicationT)
          .where(and(
            eq(aiApplicationT.id, input.applicationId),
            eq(aiApplicationT.organizationId, context.activeOrganizationId),
            isNull(aiApplicationT.deletedAt),
          ))
          .limit(1);
        if (!app) {
          throw errors.NOT_FOUND({ message: "Application not found" });
        }
      }
      set.applicationId = input.applicationId;
    }

    await getDB()
      .update(aiApiKeyT)
      .set(set)
      .where(matchActiveApiKeyInOrg(input.id, context.activeOrganizationId));
    await recordAudit(context, {
      action: "apiKey.update",
      resourceType: "aiApiKey",
      resourceId: input.id,
      details: { name: input.name, applicationId: input.applicationId },
    });
  });

const deleteApiKey = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiKey: ["delete"] }))
  .route({ method: "DELETE", path: "/{id}", tags, summary: "Soft Delete LLM API Key" })
  .input(ApiKeyDto.pick({ id: true }))
  .handler(async ({ context, input }) => {
    const rlog = log.child({ traceId: context.traceId });
    rlog.info(input, "Soft deleting api key")
    await getDB()
      .update(aiApiKeyT)
      .set({ deletedAt: new Date() })
      .where(matchActiveApiKeyInOrg(input.id, context.activeOrganizationId));
    await recordAudit(context, {
      action: "apiKey.delete",
      resourceType: "aiApiKey",
      resourceId: input.id,
    });
  });

const toggleEnabled = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiKey: ["update"] }))
  .route({ method: "POST", path: "/{id}/toggle-enabled", tags, summary: "Enable/Disable LLM API Key" })
  .input(ApiKeyDto.pick({ id: true }).extend({ enabled: z.boolean().optional() }))
  .handler(async ({ context, input, errors }) => {
    let enabled = input.enabled;
    const keySelector = matchActiveApiKeyInOrg(input.id, context.activeOrganizationId);
    if (typeof enabled !== "boolean") {
      const [apiKey] = await getDB()
        .select(pick(aiApiKeyT, "enabled"))
        .from(aiApiKeyT)
        .where(keySelector)
        .limit(1);
      if (!apiKey) throw errors.NOT_FOUND({ message: "API key not found" });
      enabled = !apiKey.enabled;
    }
    await getDB().update(aiApiKeyT).set({ enabled }).where(keySelector);
    await recordAudit(context, {
      action: "apiKey.toggle-enabled",
      resourceType: "aiApiKey",
      resourceId: input.id,
      details: { enabled },
    });
  });

const toggleCollectData = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiKey: ["update"] }))
  .route({ method: "POST", path: "/{id}/toggle-collect-data", tags, summary: "Toggle data collection for API key" })
  .input(ApiKeyDto.pick({ id: true }).extend({ collectData: z.boolean() }))
  .handler(async ({ context, input }) => {
    await getDB()
      .update(aiApiKeyT)
      .set({ collectData: input.collectData })
      .where(matchActiveApiKeyInOrg(input.id, context.activeOrganizationId));
    await recordAudit(context, {
      action: "apiKey.toggle-collect-data",
      resourceType: "aiApiKey",
      resourceId: input.id,
      details: { collectData: input.collectData },
    });
  });

export const apiKeyRouter = rootOs.prefix("/api-key").router({
  create: createApiKey,
  list: listApiKey,
  update: updateApiKey,
  delete: deleteApiKey,
  toggleEnabled,
  toggleCollectData,
});
