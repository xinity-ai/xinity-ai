import { rootOs, withOrganization, requirePermission, auditMiddleware } from "../root";
import { z } from "zod";
import { ApiKeyDto } from "$lib/orpc/dtos/api-key.dto";
import { commonInputFilter } from "$lib/orpc/dtos/common.dto";
import { sql, aiApiKeyT, aiApplicationT, apiKeyVerifier } from "common-db";
import { generateApiKey } from "$lib/server/api-key";
import { pick } from "$lib/util";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "api-key.procedure" });


const matchActiveApiKeyInOrg = (keyId: string, orgId: string) =>
  sql`${aiApiKeyT.id} = ${keyId}
    AND ${aiApiKeyT.organizationId} = ${orgId}
    AND ${aiApiKeyT.deletedAt} IS NULL`;

const tags = ["LLM API Key"];

export const createApiKey = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiKey: ["create"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "apiKey.create", resource: "apiKey", captureInput: ["name"] } })
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
    const { specifier, fullKey } = generateApiKey();

    await getDB().transaction(async (tx) => {
      if (applicationId) {
        const [application] = await tx
          .select({ id: aiApplicationT.id })
          .from(aiApplicationT)
          .where(sql`
            ${aiApplicationT.id} = ${applicationId}
            AND ${aiApplicationT.organizationId} = ${context.activeOrganizationId}
            AND ${aiApplicationT.deletedAt} IS NULL
          `)
          .limit(1);
        if (!application) {
          throw errors.NOT_FOUND({ message: "Application not found" })
        }
      } else if (input.createApplication) {
        const [newApp] = await tx
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

      await tx
        .insert(aiApiKeyT)
        .values({
          name: input.name,
          enabled: input.enabled,
          applicationId,
          organizationId: context.activeOrganizationId,
          createdByUserId: context.session.user.id,
          specifier,
          hash: apiKeyVerifier(fullKey),
        });
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
      .where(sql`
        ${aiApiKeyT.organizationId} = ${context.activeOrganizationId}
        AND ${aiApiKeyT.deletedAt} IS NULL
      `)
      .limit(400);
    return keys;
  });

const updateApiKey = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiKey: ["update"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "apiKey.update", resource: "apiKey", resourceId: { fromInput: "id" }, captureInput: ["name"] } })
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
          .where(sql`
            ${aiApplicationT.id} = ${input.applicationId}
            AND ${aiApplicationT.organizationId} = ${context.activeOrganizationId}
            AND ${aiApplicationT.deletedAt} IS NULL
          `)
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
  });

const deleteApiKey = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiKey: ["delete"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "apiKey.delete", resource: "apiKey", resourceId: { fromInput: "id" } } })
  .route({ method: "DELETE", path: "/{id}", tags, summary: "Soft Delete LLM API Key" })
  .input(ApiKeyDto.pick({ id: true }))
  .handler(async ({ context, input }) => {
    const rlog = log.child({ traceId: context.traceId });
    rlog.info(input, "Soft deleting api key")
    await getDB()
      .update(aiApiKeyT)
      .set({ deletedAt: new Date() })
      .where(matchActiveApiKeyInOrg(input.id, context.activeOrganizationId));
  });

const toggleEnabled = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiKey: ["update"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "apiKey.toggle_enabled", resource: "apiKey", resourceId: { fromInput: "id" }, captureInput: ["enabled"] } })
  .route({ method: "PATCH", path: "/{id}/toggle-enabled", tags, summary: "Enable/Disable LLM API Key" })
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
  });

const toggleCollectData = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiKey: ["update"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "apiKey.toggle_collect_data", resource: "apiKey", resourceId: { fromInput: "id" }, captureInput: ["collectData"] } })
  .route({ method: "PATCH", path: "/{id}/toggle-collect-data", tags, summary: "Toggle data collection for API key" })
  .input(ApiKeyDto.pick({ id: true }).extend({ collectData: z.boolean() }))
  .handler(async ({ context, input }) => {
    await getDB()
      .update(aiApiKeyT)
      .set({ collectData: input.collectData })
      .where(matchActiveApiKeyInOrg(input.id, context.activeOrganizationId));
  });

export const apiKeyRouter = rootOs.prefix("/api-key").router({
  create: createApiKey,
  list: listApiKey,
  update: updateApiKey,
  delete: deleteApiKey,
  toggleEnabled,
  toggleCollectData,
});
