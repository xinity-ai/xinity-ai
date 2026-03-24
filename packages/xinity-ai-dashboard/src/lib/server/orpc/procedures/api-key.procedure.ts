import { rootOs, withOrganization, requirePermission } from "../root";
import { z } from "zod";
import { ApiKeyDto } from "$lib/orpc/dtos/api-key.dto";
import { commonInputFilter } from "$lib/orpc/dtos/common.dto";
import { randomBytes } from "node:crypto";
import { and, eq, sql, aiApiKeyT, aiApplicationT, userT, isNull } from "common-db";
import { pick } from "$lib/util";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "api-key.procedure" });

function generateRandomKey(length = 64) {
  return randomBytes(length).toString("base64url"); // URL-safe base64 string
}

const tags = ["LLM Api Key"];

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

    log.info({ keyName: input.name, org: context.activeOrganizationId }, "Creating new API key")

    let applicationId: string | null = input.applicationId ?? null;

    if (applicationId) {
      const [application] = await getDB()
        .select().from(aiApplicationT).where(sql`
        ${aiApplicationT.id} = ${applicationId}
        AND
        ${aiApplicationT.organizationId} = ${context.activeOrganizationId}
        `).limit(1);
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
      applicationId = newApp.id;
    }
    // If neither applicationId nor createApplication: key has no default application

    const specifier = "sk_" + generateRandomKey(16);
    const secretKey = generateRandomKey();

    const fullKey = `${specifier}${secretKey}`;
    const hash = await Bun.password.hash(fullKey);
    const [newKey] = await getDB()
      .insert(aiApiKeyT)
      .values({
        name: input.name,
        enabled: input.enabled,
        applicationId,
        organizationId: context.activeOrganizationId,
        createdByUserId: context.session.user.id,
        specifier,
        hash: hash,
      }).returning();
    return {
      fullKey,
      name: input.name,
      specifier,
      applicationId: newKey.applicationId,
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
          sql`${aiApiKeyT.organizationId} = ${context.activeOrganizationId}`,
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
            sql`${aiApplicationT.organizationId} = ${context.activeOrganizationId}`,
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
      .where(sql`
          ${aiApiKeyT.id} = ${input.id}
        AND
          ${aiApiKeyT.organizationId} = ${context.activeOrganizationId}
      `);
  });

const deleteApiKey = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiKey: ["delete"] }))
  .route({ method: "DELETE", path: "/{id}", tags, summary: "Soft Delete LLM Api Key" })
  .input(ApiKeyDto.pick({ id: true }))
  .handler(async ({ context, input }) => {
    log.info(input, "Soft deleting api key")
    await getDB()
      .update(aiApiKeyT)
      .set({ deletedAt: new Date() })
      .where(
        and(
          sql`${aiApiKeyT.id} = ${input.id}`,
          sql`${aiApiKeyT.organizationId} = ${context.activeOrganizationId}`,
          isNull(aiApiKeyT.deletedAt)
        )
      );
  });

const toggleEnabled = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiKey: ["update"] }))
  .route({ method: "POST", path: "/{id}/toggle-enabled", tags, summary: "Enable/Disable LLM Api Key" })
  .input(ApiKeyDto.pick({ id: true }).extend({ enabled: z.boolean().optional() }))
  .handler(async ({ context, input }) => {
    let enabled = input.enabled;
    const keySelector = sql`
      ${aiApiKeyT.id} = ${input.id} 
      AND 
      ${aiApiKeyT.organizationId} = ${context.activeOrganizationId}`;
    if (typeof enabled !== "boolean") {
      const [apiKey] = await getDB()
        .select(pick(aiApiKeyT, "enabled"))
        .from(aiApiKeyT)
        .where(keySelector)
        .orderBy(aiApiKeyT.name);
      enabled = !apiKey.enabled;
    }
    await getDB().update(aiApiKeyT).set({ enabled }).where(keySelector);
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
      .where(
        and(
          sql`${aiApiKeyT.id} = ${input.id}`,
          sql`${aiApiKeyT.organizationId} = ${context.activeOrganizationId}`,
        )
      );
  });

export const apiKeyRouter = rootOs.prefix("/api-key").router({
  create: createApiKey,
  list: listApiKey,
  update: updateApiKey,
  delete: deleteApiKey,
  toggleEnabled,
  toggleCollectData,
});
