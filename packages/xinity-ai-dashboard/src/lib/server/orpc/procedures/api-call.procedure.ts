/**
 * ORPC procedures for API call data.
 */
import { rootOs, withOrganization, requirePermission, auditMiddleware } from "../root";
import { z } from "zod";
import { sql, aiApiKeyT, apiCallT, inferenceCallT } from "common-db";
import { getDB } from "$lib/server/db";
import { resolveCallMessages } from "$lib/server/call-messages";
import { inferenceToCallRecord, legacyToCallRecord, type CallRecord } from "$lib/server/call-record";

const tags = ["API Call"];

const matchKeyInOrg = (keyId: string, orgId: string) =>
  sql`
    ${aiApiKeyT.id} = ${keyId}
  AND
    ${aiApiKeyT.organizationId} = ${orgId}
  `;

async function findApiKeyInOrg(keyId: string, orgId: string) {
  const [key] = await getDB()
    .select()
    .from(aiApiKeyT)
    .where(matchKeyInOrg(keyId, orgId))
    .limit(1);
  return key;
}

const CALL_LIST_LIMIT = 5000;

async function listCallsForKey(keyId: string): Promise<CallRecord[]> {
  const db = getDB();
  const [legacy, inference] = await Promise.all([
    db.select().from(apiCallT)
      .where(sql`${apiCallT.apiKeyId} = ${keyId}`)
      .orderBy(apiCallT.createdAt).limit(CALL_LIST_LIMIT),
    db.select().from(inferenceCallT)
      .where(sql`${inferenceCallT.apiKeyId} = ${keyId}`)
      .orderBy(inferenceCallT.createdAt).limit(CALL_LIST_LIMIT),
  ]);

  const messages = await resolveCallMessages(inference.map((call) => call.id));

  return [
    ...legacy.map(legacyToCallRecord),
    ...inference.map((call) => inferenceToCallRecord(call, messages.get(call.id))),
  ]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, CALL_LIST_LIMIT);
}

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

    return listCallsForKey(input.apiKeyId);
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
      .delete(inferenceCallT)
      .where(sql`
        ${inferenceCallT.organizationId} = ${context.activeOrganizationId}
      AND
        ${inferenceCallT.id} IN ${input.apiCallIds}
      `)
      .returning({ id: inferenceCallT.id });
    return { deleted: result.length };
  });

/** Updates metadata for a specific API call. */
const updateMetadata = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiCall: ["update"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "apiCall.update_metadata", resource: "apiCall", resourceId: { fromInput: "callId" } } })
  .route({ path: "/{callId}/metadata", method: "PATCH", tags, summary: "Update API call metadata" })
  .input(z.object({
    callId: z.uuid(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }))
  .errors({ NOT_FOUND: { message: "API call not found" } })
  .handler(async ({ context, input, errors }) => {
    const result = await getDB()
      .update(inferenceCallT)
      .set({ metadata: input.metadata ?? {} })
      .where(sql`
        ${inferenceCallT.id} = ${input.callId}
      AND
        ${inferenceCallT.organizationId} = ${context.activeOrganizationId}
      `)
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
      .update(inferenceCallT)
      .set({ applicationId: input.applicationId })
      .where(sql`
        ${inferenceCallT.organizationId} = ${context.activeOrganizationId}
      AND
        ${inferenceCallT.id} IN ${input.apiCallIds}
      `)
      .returning({ id: inferenceCallT.id });
    return { reassigned: result.length };
  });

export const apiCallRouter = rootOs.prefix("/api-call").router({
  list: listApiCalls,
  delete: deleteApiCalls,
  updateMetadata,
  reassignApplication,
});
