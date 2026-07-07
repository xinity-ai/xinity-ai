/**
 * ORPC procedures for API call data and seeded examples.
 */
import { rootOs, withOrganization, requirePermission, auditMiddleware } from "../root";
import { z } from "zod";
import exampleCalls from "./example.call.data.json" with { type: "json" };
import { sql, aiApiKeyT, apiCallT, type ApiCallInputMessage } from "common-db";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "api-call.procedure" });

const tags = ["API Call"];

const matchKeyInOrg = (keyId: string, orgId: string) =>
  sql`${aiApiKeyT.id} = ${keyId} AND ${aiApiKeyT.organizationId} = ${orgId}`;

async function findApiKeyInOrg(keyId: string, orgId: string) {
  const [key] = await getDB()
    .select()
    .from(aiApiKeyT)
    .where(matchKeyInOrg(keyId, orgId))
    .limit(1);
  return key;
}

/** Adds seeded example API calls for a specific API key (dev-only). */
const addExampleCalls = rootOs
  .meta({mcp: false})
  .use(withOrganization)
  .use(requirePermission({ apiCall: ["delete"] }))
  .route({ method: "POST", path: "/add-example-data", tags: [...tags, ".internal"], summary: "Add example api calls (dev)" })
  .input(z.object({ apiKeyId: z.uuid(), applicationId: z.uuid() }))
  .errors({
    NOT_FOUND: { message: "API key not found" },
    NOT_ACCEPTABLE: { message: "Dev-only procedure" },
  })
  .handler(async ({ context, input, errors }) => {
    if (process.env.NODE_ENV === "production") {
      throw errors.NOT_ACCEPTABLE();
    }
    const rlog = log.child({ traceId: context.traceId });
    const orgId = context.activeOrganizationId;
    const key = await findApiKeyInOrg(input.apiKeyId, orgId);
    if (!key) {
      throw errors.NOT_FOUND();
    }

    try {
      await getDB()
        .insert(apiCallT)
        .values(
          exampleCalls.map((v) => ({
            ...v,
            apiKeyId: key.id,
            applicationId: input.applicationId,
            organizationId: orgId,
            specifiedModel: v.model,
            inputMessages: v.inputMessages as ApiCallInputMessage[],
            outputMessage: v.outputMessage as ApiCallInputMessage,
          })),
        );

    } catch (e) {
      rlog.error({ err: e }, "Error inserting example calls");
      throw e;
    }
  });


/** Lists API calls for a specific API key in the active organization. */
const listApiCalls = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiCall: ["read"] }))
  .errors({ NOT_FOUND: { message: "API key not found" } })
  .route({ path: "/", method: "GET", tags, summary: "List API Calls" })
  .input(z.object({ apiKeyId: z.uuid() }))
  .handler(async ({ context, input, errors }) => {
    const apiKey = await findApiKeyInOrg(input.apiKeyId, context.activeOrganizationId);
    if (!apiKey) {
      throw errors.NOT_FOUND();
    }

    const apiCalls = await getDB().select()
      .from(apiCallT).orderBy(apiCallT.createdAt)
      .where(sql`${apiCallT.apiKeyId} = ${input.apiKeyId}`).limit(5000);

    return apiCalls;
  });

/** Deletes API calls in the active organization. */
const deleteApiCalls = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiCall: ["delete"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "apiCall.delete", resource: "apiCall" } })
  .route({ path: "/", method: "DELETE", tags, summary: "Delete API calls" })
  .input(z.object({
    apiCallIds: z.uuid().array().min(1).max(500),
  }))
  .handler(async ({ context, input }) => {
    const result = await getDB()
      .delete(apiCallT)
      .where(sql`${apiCallT.organizationId} = ${context.activeOrganizationId} AND ${apiCallT.id} IN ${input.apiCallIds}`)
      .returning({ id: apiCallT.id });
    return { deleted: result.length };
  });

/** Updates metadata for a specific API call. */
const updateMetadata = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiCall: ["update"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "apiCall.update_metadata", resource: "apiCall" } })
  .route({ path: "/{callId}/metadata", method: "PATCH", tags, summary: "Update API call metadata" })
  .input(z.object({
    callId: z.uuid(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }))
  .errors({ NOT_FOUND: { message: "API call not found" } })
  .handler(async ({ context, input, errors }) => {
    const result = await getDB()
      .update(apiCallT)
      .set({ metadata: input.metadata ?? null })
      .where(sql`${apiCallT.id} = ${input.callId} AND ${apiCallT.organizationId} = ${context.activeOrganizationId}`)
      .returning();
    if (!result.length) {
      throw errors.NOT_FOUND();
    }
    return result[0];
  });

/** Reassigns API calls to a different application. */
const reassignApplication = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiCall: ["update"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "apiCall.reassign_application", resource: "apiCall" } })
  .route({ path: "/reassign-application", method: "POST", tags, summary: "Reassign API calls to a different application" })
  .input(z.object({
    apiCallIds: z.uuid().array().min(1).max(500),
    applicationId: z.uuid().nullable(),
  }))
  .handler(async ({ context, input }) => {
    const result = await getDB()
      .update(apiCallT)
      .set({ applicationId: input.applicationId })
      .where(sql`${apiCallT.organizationId} = ${context.activeOrganizationId} AND ${apiCallT.id} IN ${input.apiCallIds}`)
      .returning({ id: apiCallT.id });
    return { reassigned: result.length };
  });

export const apiCallRouter = rootOs.prefix("/api-call").router({
  addExampleCalls,
  list: listApiCalls,
  delete: deleteApiCalls,
  updateMetadata,
  reassignApplication,
});
