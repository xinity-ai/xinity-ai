import { command, getRequestEvent, query } from '$app/server';
import { auth } from '$lib/server/auth-server';
import { getDB } from '$lib/server/db';
import { callMatchesSearch, legacyMatchesSearch, resolveCallMessages, searchPattern } from "$lib/server/call-messages";
import { pick } from '$lib/util';
import { error } from '@sveltejs/kit';
import { apiCallResponseT, apiCallT, aiApiKeyT, inferenceCallT, inferenceCallRatingT, sql, unionAll, type ApiCall, type AiApiKey, type PgColumn, and, inArray } from 'common-db';
import z from 'zod';

async function getSession() {
  const { locals, } = getRequestEvent();
  const session = await auth.api.getSession({ headers: locals.request.headers });
  if (!session) {
    throw error(401, "Not logged in")
  }
  return session;
}

/** Only `inference_call` answers yes. A legacy row is frozen, so nothing may act on it. */
async function callIsWritable(callId: string, organizationId: string | null | undefined): Promise<boolean> {
  const [call] = await getDB()
    .select({ id: inferenceCallT.id })
    .from(inferenceCallT)
    .where(sql`
      ${inferenceCallT.id} = ${callId}
    AND
      ${inferenceCallT.organizationId} = ${organizationId}
    `)
    .limit(1);
  return !!call;
}

type CallFilters = {
  organizationId: string;
  applicationId: string | null;
  apiKeyId?: string;
  metadataKey?: string;
  metadataValue?: string;
  searchQuery?: string;
};

/** The filters both tables answer the same way, given that table's columns. */
function commonConditions(
  opts: CallFilters,
  col: { organizationId: PgColumn; applicationId: PgColumn; apiKeyId: PgColumn; metadata: PgColumn },
) {
  const conditions = [sql`${col.organizationId} = ${opts.organizationId}`];
  conditions.push(opts.applicationId
    ? sql`${col.applicationId} = ${opts.applicationId}`
    : sql`${col.applicationId} IS NULL`);
  if (opts.apiKeyId) {
    conditions.push(sql`${col.apiKeyId} = ${opts.apiKeyId}`);
  }
  if (opts.metadataKey && opts.metadataValue) {
    conditions.push(sql`${col.metadata} @> ${JSON.stringify({ [opts.metadataKey]: opts.metadataValue })}::jsonb`);
  }
  return conditions;
}

/** The two tables never hold the same call: the gateway writes only `inference_call`, and the
 * postfill deletes a legacy row as it converts it. */
function legacyConditions(opts: CallFilters) {
  const conditions = commonConditions(opts, apiCallT);
  if (opts.searchQuery && opts.searchQuery.trim().length > 0) {
    conditions.push(legacyMatchesSearch(searchPattern(opts.searchQuery)));
  }
  return conditions;
}

function inferenceConditions(opts: CallFilters) {
  const conditions = commonConditions(opts, inferenceCallT);
  if (opts.searchQuery && opts.searchQuery.trim().length > 0) {
    conditions.push(callMatchesSearch(sql`${inferenceCallT.id}`, searchPattern(opts.searchQuery)));
  }
  return conditions;
}

export const getApiKeys = query(z.object({ applicationId: z.uuid().nullable() }), async ({ applicationId }) => {
  const { session } = await getSession();
  if (!session.activeOrganizationId) {
    return [] as PartialPublicApiKey[];
  }

  const conditions = [
    sql`${aiApiKeyT.organizationId} = ${session.activeOrganizationId}`,
    sql`${aiApiKeyT.deletedAt} IS NULL`,
  ];

  if (applicationId) {
    conditions.push(sql`${aiApiKeyT.applicationId} = ${applicationId}`);
  } else {
    // For uncategorized view, show keys without a default application
    conditions.push(sql`${aiApiKeyT.applicationId} IS NULL`);
  }

  const apiKeys = await getDB()
    .select(pick(aiApiKeyT, "name", "enabled", "specifier", "createdAt", "id", "applicationId"))
    .from(aiApiKeyT)
    .where(and(...conditions))
    .limit(400);
  return apiKeys as PartialPublicApiKey[];
})

const apiCallFilters = z.object({
  applicationId: z.uuid().nullable(),
  apiKeyId: z.uuid().optional(),
  sortOption: z.enum(["newest", "oldest", "duration"]).optional(),
  metadataKey: z.string().optional(),
  metadataValue: z.string().optional(),
  searchQuery: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
})

type ApiCallSortOption = z.infer<typeof apiCallFilters>["sortOption"];

/** Which table a listed call came from. The Data view renders both the same way; this exists so
 * it can tell them apart when it needs to, and so messages are fetched from the right place. */
export type CallSource = "legacy" | "inference";
export type DataViewCall = Pick<
  ApiCall,
  "id" | "apiKeyId" | "applicationId" | "createdAt" | "duration"
  | "model" | "specifiedModel" | "user" | "metadata" | "inputMessages" | "outputMessage"
> & { source: CallSource };

export const getApiCalls = query(apiCallFilters, async ({ applicationId, apiKeyId, sortOption, metadataKey, metadataValue, searchQuery, limit = 50, offset = 0 }) => {
  const { session } = await getSession();
  if (!session.activeOrganizationId) {
    return [] as DataViewCall[];
  }

  const filters = {
    organizationId: session.activeOrganizationId,
    applicationId,
    apiKeyId,
    metadataKey,
    metadataValue,
    searchQuery,
  };
  const db = getDB();

  // Only the columns both tables have. Messages are attached below, from whichever side holds them.
  const legacy = db
    .select({
      id: apiCallT.id,
      source: sql<CallSource>`'legacy'`.as("source"),
      apiKeyId: apiCallT.apiKeyId,
      applicationId: apiCallT.applicationId,
      createdAt: apiCallT.createdAt,
      duration: apiCallT.duration,
      model: apiCallT.model,
      specifiedModel: apiCallT.specifiedModel,
      user: apiCallT.user,
      metadata: apiCallT.metadata,
    })
    .from(apiCallT)
    .where(and(...legacyConditions(filters)));

  const inference = db
    .select({
      id: inferenceCallT.id,
      source: sql<CallSource>`'inference'`.as("source"),
      apiKeyId: inferenceCallT.apiKeyId,
      applicationId: inferenceCallT.applicationId,
      createdAt: inferenceCallT.createdAt,
      duration: inferenceCallT.duration,
      model: inferenceCallT.model,
      specifiedModel: inferenceCallT.specifiedModel,
      user: inferenceCallT.user,
      metadata: inferenceCallT.metadata,
    })
    .from(inferenceCallT)
    .where(and(...inferenceConditions(filters)));

  const page = await unionAll(legacy, inference)
    .orderBy(unionOrderBy(sortOption))
    .limit(limit)
    .offset(offset);

  return attachMessages(page);
});

/** Sorting spans the union, so it names the projected columns rather than either table's. */
function unionOrderBy(sortOption: ApiCallSortOption) {
  if (sortOption === "oldest") return sql`created_at ASC`;
  if (sortOption === "duration") return sql`duration DESC`;
  return sql`created_at DESC`;
}

type PagedCall = Omit<DataViewCall, "inputMessages" | "outputMessage">;

/** Two lookups for the page rather than one per row: legacy rows carry their messages inline,
 * inference rows reference them. */
async function attachMessages(page: PagedCall[]): Promise<DataViewCall[]> {
  const legacyIds = page.filter((call) => call.source === "legacy").map((call) => call.id);
  const inferenceIds = page.filter((call) => call.source === "inference").map((call) => call.id);

  const [legacyRows, resolved] = await Promise.all([
    legacyIds.length === 0
      ? []
      : getDB()
        .select(pick(apiCallT, "id", "inputMessages", "outputMessage"))
        .from(apiCallT)
        .where(inArray(apiCallT.id, legacyIds)),
    resolveCallMessages(inferenceIds),
  ]);

  const legacyMessages = new Map(legacyRows.map((row) => [row.id, row]));

  return page.map((call) => {
    const own = call.source === "legacy"
      ? legacyMessages.get(call.id)
      : resolved.get(call.id);
    return {
      ...call,
      inputMessages: own?.inputMessages ?? [],
      outputMessage: own?.outputMessage ?? { role: "assistant", content: "" },
    } as DataViewCall;
  });
}

const apiCallCountFilters = z.object({
  applicationId: z.uuid().nullable(),
  apiKeyId: z.uuid().optional(),
  metadataKey: z.string().optional(),
  metadataValue: z.string().optional(),
  searchQuery: z.string().optional(),
});

export const getApiCallCount = query(apiCallCountFilters, async (params) => {
  const { session } = await getSession();
  if (!session.activeOrganizationId) return 0;

  const filters = { organizationId: session.activeOrganizationId, ...params };
  const db = getDB();
  const total = sql<number>`COUNT(*)::int`;

  // Summed rather than counted over the union: the twin exclusion already makes the two disjoint.
  const [[legacy], [inference]] = await Promise.all([
    db.select({ count: total }).from(apiCallT).where(and(...legacyConditions(filters))),
    db.select({ count: total }).from(inferenceCallT).where(and(...inferenceConditions(filters))),
  ]);

  return (legacy?.count ?? 0) + (inference?.count ?? 0);
});

export type ApiCallReactionSummary = {
  apiCallId: string;
  likes: number;
  dislikes: number;
  total: number;
};

export const getApiCallReactionSummary = query.batch(z.uuid(), async (ids) => {
  const summaries = await getDB()
    .select({
      apiCallId: apiCallResponseT.apiCallId,
      likes: sql<number>`COUNT(CASE WHEN ${apiCallResponseT.response} = true THEN 1 END)::int`,
      dislikes: sql<number>`COUNT(CASE WHEN ${apiCallResponseT.response} = false THEN 1 END)::int`,
      total: sql<number>`COUNT(CASE WHEN ${apiCallResponseT.response} IS NOT NULL THEN 1 END)::int`,
    })
    .from(apiCallResponseT)
    .where(inArray(apiCallResponseT.apiCallId, ids))
    .groupBy(apiCallResponseT.apiCallId);

  return (id) =>
    summaries.find((summary) => summary.apiCallId === id) ?? {
      apiCallId: id,
      likes: 0,
      dislikes: 0,
      total: 0,
    };
});

export const getAPICallResponse = query.batch(z.uuid(), async (ids) => {
  const session = await getSession();
  const userId = session.user.id;

  const responses = await getDB().select().from(apiCallResponseT)
    .where(sql`
      ${inArray(apiCallResponseT.apiCallId, ids)}
    AND
      ${apiCallResponseT.userId} = ${userId}
    `);

  return id => responses.find(v => v.apiCallId === id);

})

export type PartialPublicApiKey = Pick<AiApiKey, "name" | "enabled" | "specifier" | "createdAt" | "id" | "applicationId">;

export const upsertApiCallResponse = command(z.object({
  apiCallId: z.uuid(),
  payload: z.object({
    response: z.boolean().nullable().optional(),
    outputEdit: z.string().optional(),
    highlights: z.object({
      start: z.number(),
      end: z.number(),
      type: z.boolean(),
    }).array().optional(),
    excludedMessages: z.number().int().array().optional(),
    inputExclusions: z.object({
      messageIndex: z.number().int(),
      start: z.number().int(),
      end: z.number().int(),
    }).array().optional(),
  }),
}), async ({ apiCallId, payload }) => {
  const { session, user } = await getSession();

  if (!await callIsWritable(apiCallId, session.activeOrganizationId)) {
    error(404, { message: "The call was not found" });
  }

  const newObj = await getDB().insert(inferenceCallRatingT).values({
    callId: apiCallId,
    userId: user.id,
    ...payload,
  }).onConflictDoUpdate({ set: payload, target: [inferenceCallRatingT.callId, inferenceCallRatingT.userId] });
  getAPICallResponse(apiCallId).refresh();
  getApiCallReactionSummary(apiCallId).refresh();
  return newObj;
}
)

export const deleteApiCall = command(z.object({ apiCallId: z.uuid() }), async ({ apiCallId }) => {
  const { session } = await getSession();
  if (!session.activeOrganizationId) {
    throw error(403, { message: "No active organization" });
  }

  if (!await callIsWritable(apiCallId, session.activeOrganizationId)) {
    throw error(404, { message: "The call was not found" });
  }

  await getDB().delete(inferenceCallT).where(sql`${inferenceCallT.id} = ${apiCallId}`);

  return { success: true };
});
