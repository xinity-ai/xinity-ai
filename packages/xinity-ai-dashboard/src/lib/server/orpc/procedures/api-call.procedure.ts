/**
 * ORPC procedures for API call data and seeded examples.
 */
import { rootOs, withOrganization, requirePermission } from "../root";
import { z } from "zod";
import exampleCalls from "./example.call.data.json" with { type: "json" };
import { and, eq, aiApiKeyT, apiCallT, type ApiCallInputMessage } from "common-db";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "api-call.procedure" });

const tags = ["API Call"];

const matchKeyInOrg = (keyId: string, orgId: string) => and(
  eq(aiApiKeyT.id, keyId),
  eq(aiApiKeyT.organizationId, orgId),
);

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
  .route({ method: "POST", path: "/add-example-data", tags: [...tags, ".internal"], summary: "Add example api calls (dev)" })
  .input(z.object({ apiKeyId: z.uuid(), applicationId: z.uuid() }))
  .errors({ NOT_FOUND: { message: "API key not found" }, NOT_ACCEPTABLE: { message: "Environment mismatch. This is not available in production" } })
  .handler(async ({ context, input, errors }) => {
    const rlog = log.child({ traceId: context.traceId });
    if (process.env.NODE_ENV === "production") {
      throw errors.NOT_ACCEPTABLE();
    }

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
      throw errors.NOT_FOUND({ message: "No such api key found" });
    }

    const apiCalls = await getDB().select()
      .from(apiCallT).orderBy(apiCallT.createdAt)
      .where(eq(apiCallT.apiKeyId, input.apiKeyId)).limit(5000);

    return apiCalls;
  });

export const apiCallRouter = rootOs.prefix("/api-call").router({
  addExampleCalls,
  list: listApiCalls,
});
