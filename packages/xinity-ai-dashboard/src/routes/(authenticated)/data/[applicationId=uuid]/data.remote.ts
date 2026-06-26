import { command, getRequestEvent, query } from '$app/server';
import { auth } from '$lib/server/auth-server';
import { getDB } from '$lib/server/db';
import { pick } from '$lib/util';
import { error } from '@sveltejs/kit';
import { apiCallResponseT, apiCallT, aiApiKeyT, sql, type ApiCall, type AiApiKey, isNull, and, eq, inArray } from 'common-db';
import z from 'zod';

async function getSession() {
  const { locals, } = getRequestEvent();
  const session = await auth.api.getSession(locals.request);
  if (!session) {
    throw error(401, "Not logged in")
  }
  return session;
}

function escapeLikePattern(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

async function apiCallExistsInOrg(apiCallId: string, organizationId: string | null | undefined): Promise<boolean> {
  const [apiCall] = await getDB()
    .select({ id: apiCallT.id })
    .from(apiCallT)
    .where(sql`${apiCallT.id} = ${apiCallId} AND ${apiCallT.organizationId} = ${organizationId}`)
    .limit(1);
  return !!apiCall;
}

function buildApiCallConditions(opts: {
  organizationId: string;
  applicationId: string | null;
  apiKeyId?: string;
  metadataKey?: string;
  metadataValue?: string;
  searchQuery?: string;
}) {
  const conditions = [
    eq(apiCallT.organizationId, opts.organizationId),
  ];
  if (opts.applicationId) {
    conditions.push(eq(apiCallT.applicationId, opts.applicationId));
  } else {
    conditions.push(isNull(apiCallT.applicationId));
  }
  if (opts.apiKeyId) {
    conditions.push(eq(apiCallT.apiKeyId, opts.apiKeyId));
  }
  if (opts.metadataKey && opts.metadataValue) {
    conditions.push(sql`${apiCallT.metadata} @> ${JSON.stringify({ [opts.metadataKey]: opts.metadataValue })}::jsonb`);
  }
  if (opts.searchQuery && opts.searchQuery.trim().length > 0) {
    const term = `%${escapeLikePattern(opts.searchQuery.trim())}%`;
    conditions.push(
      sql`(${apiCallT.inputMessages}::text ILIKE ${term} OR ${apiCallT.outputMessage}::text ILIKE ${term})`
    );
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
    isNull(aiApiKeyT.deletedAt),
  ];

  if (applicationId) {
    conditions.push(sql`${aiApiKeyT.applicationId} = ${applicationId}`);
  } else {
    // For uncategorized view, show keys without a default application
    conditions.push(isNull(aiApiKeyT.applicationId));
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

function apiCallOrderBy(sortOption: ApiCallSortOption) {
  if (sortOption === "oldest") return sql`${apiCallT.createdAt} ASC`;
  if (sortOption === "duration") return sql`${apiCallT.duration} DESC`;
  return sql`${apiCallT.createdAt} DESC`;
}

export const getApiCalls = query(apiCallFilters, async ({ applicationId, apiKeyId, sortOption, metadataKey, metadataValue, searchQuery, limit = 50, offset = 0 }) => {
  const { session } = await getSession();
  if (!session.activeOrganizationId) {
    return [] as ApiCall[];
  }

  const conditions = buildApiCallConditions({
    organizationId: session.activeOrganizationId,
    applicationId,
    apiKeyId,
    metadataKey,
    metadataValue,
    searchQuery,
  });

  const select = pick(apiCallT, "id", "apiKeyId", "createdAt", "duration", "inputMessages", "outputMessage", "model", "specifiedModel", "user", "applicationId", "metadata");
  const apiCalls = await getDB()
    .select(select)
    .from(apiCallT)
    .where(and(...conditions))
    .orderBy(apiCallOrderBy(sortOption))
    .limit(limit)
    .offset(offset);
  return apiCalls as ApiCall[];
});

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

  const conditions = buildApiCallConditions({
    organizationId: session.activeOrganizationId,
    ...params,
  });

  const [result] = await getDB()
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(apiCallT)
    .where(and(...conditions));

  return result?.count ?? 0;
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
    .where(and(
      inArray(apiCallResponseT.apiCallId, ids),
      eq(apiCallResponseT.userId, userId),
    ));

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

  if (!await apiCallExistsInOrg(apiCallId, session.activeOrganizationId)) {
    error(404, { message: "The api Call was not found" });
  }

  const newObj = await getDB().insert(apiCallResponseT).values({
    apiCallId: apiCallId,
    userId: user.id,
    ...payload,
  }).onConflictDoUpdate({ set: payload, target: [apiCallResponseT.apiCallId, apiCallResponseT.userId] });
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

  if (!await apiCallExistsInOrg(apiCallId, session.activeOrganizationId)) {
    throw error(404, { message: "The api Call was not found" });
  }

  await getDB().transaction(async (tx) => {
    await tx.delete(apiCallResponseT).where(sql`${apiCallResponseT.apiCallId} = ${apiCallId}`);
    await tx.delete(apiCallT).where(sql`${apiCallT.id} = ${apiCallId}`);
  });

  return { success: true };
});
