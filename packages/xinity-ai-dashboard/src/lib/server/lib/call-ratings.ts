/**
 * Ratings live in `inference_call_rating` for new calls and `api_call_response` for calls that
 * predate the migration. A call id exists in exactly one of the two, so resolving is a merge
 * rather than a union, and callers keep seeing the single `ApiCallResponse` shape.
 */
import {
  apiCallResponseT,
  apiCallT,
  inferenceCallRatingT,
  inferenceCallT,
  sql,
  inArray,
  type ApiCallResponse,
  type PgColumn,
} from "common-db";
import { getDB } from "../db";

export type ReactionSummary = {
  apiCallId: string;
  likes: number;
  dislikes: number;
  total: number;
};

export type RatingTotals = {
  liked: number;
  disliked: number;
  unrated: number;
  total: number;
  edited: number;
  rated: number;
};

const EMPTY_TOTALS: RatingTotals = {
  liked: 0, disliked: 0, unrated: 0, total: 0, edited: 0, rated: 0,
};

export async function resolveUserRatings(
  callIds: string[],
  userId: string,
): Promise<Map<string, ApiCallResponse>> {
  if (callIds.length === 0) {
    return new Map();
  }

  const db = getDB();
  const [legacy, current] = await Promise.all([
    db.select().from(apiCallResponseT).where(sql`
      ${inArray(apiCallResponseT.apiCallId, callIds)} AND ${apiCallResponseT.userId} = ${userId}
    `),
    db.select().from(inferenceCallRatingT).where(sql`
      ${inArray(inferenceCallRatingT.callId, callIds)} AND ${inferenceCallRatingT.userId} = ${userId}
    `),
  ]);

  const resolved = new Map<string, ApiCallResponse>();
  for (const row of legacy) {
    resolved.set(row.apiCallId, row);
  }
  for (const { callId, verdict, ...rest } of current) {
    resolved.set(callId, { ...rest, apiCallId: callId, response: verdict });
  }
  return resolved;
}

export async function resolveReactionSummaries(
  callIds: string[],
): Promise<Map<string, ReactionSummary>> {
  if (callIds.length === 0) {
    return new Map();
  }

  const counters = (verdict: PgColumn) => ({
    likes: sql<number>`COUNT(CASE WHEN ${verdict} = true THEN 1 END)::int`,
    dislikes: sql<number>`COUNT(CASE WHEN ${verdict} = false THEN 1 END)::int`,
    total: sql<number>`COUNT(CASE WHEN ${verdict} IS NOT NULL THEN 1 END)::int`,
  });

  const db = getDB();
  const [legacy, current] = await Promise.all([
    db.select({ apiCallId: apiCallResponseT.apiCallId, ...counters(apiCallResponseT.response) })
      .from(apiCallResponseT)
      .where(inArray(apiCallResponseT.apiCallId, callIds))
      .groupBy(apiCallResponseT.apiCallId),
    db.select({ apiCallId: inferenceCallRatingT.callId, ...counters(inferenceCallRatingT.verdict) })
      .from(inferenceCallRatingT)
      .where(inArray(inferenceCallRatingT.callId, callIds))
      .groupBy(inferenceCallRatingT.callId),
  ]);

  return new Map([...legacy, ...current].map((row) => [row.apiCallId, row]));
}

export async function resolveRatingTotals(userId: string): Promise<RatingTotals> {
  const counters = (verdict: PgColumn, outputEdit: PgColumn) => ({
    liked: sql<number>`COUNT(CASE WHEN ${verdict} = true THEN 1 END)::int`,
    disliked: sql<number>`COUNT(CASE WHEN ${verdict} = false THEN 1 END)::int`,
    unrated: sql<number>`COUNT(CASE WHEN ${verdict} IS NULL THEN 1 END)::int`,
    total: sql<number>`COUNT(*)::int`,
    edited: sql<number>`COUNT(CASE WHEN ${outputEdit} IS NOT NULL THEN 1 END)::int`,
    rated: sql<number>`COUNT(CASE WHEN ${verdict} IS NOT NULL THEN 1 END)::int`,
  });

  const db = getDB();
  const [[legacy], [current]] = await Promise.all([
    db.select(counters(apiCallResponseT.response, apiCallResponseT.outputEdit))
      .from(apiCallResponseT)
      .where(sql`${apiCallResponseT.userId} = ${userId}`),
    db.select(counters(inferenceCallRatingT.verdict, inferenceCallRatingT.outputEdit))
      .from(inferenceCallRatingT)
      .where(sql`${inferenceCallRatingT.userId} = ${userId}`),
  ]);

  const a = legacy ?? EMPTY_TOTALS;
  const b = current ?? EMPTY_TOTALS;
  return {
    liked: a.liked + b.liked,
    disliked: a.disliked + b.disliked,
    unrated: a.unrated + b.unrated,
    total: a.total + b.total,
    edited: a.edited + b.edited,
    rated: a.rated + b.rated,
  };
}

export async function organizationHasRating(orgId: string): Promise<boolean> {
  const db = getDB();
  const [legacy, current] = await Promise.all([
    db.select({ id: apiCallResponseT.apiCallId })
      .from(apiCallResponseT)
      .innerJoin(apiCallT, sql`${apiCallT.id} = ${apiCallResponseT.apiCallId}`)
      .where(sql`${apiCallT.organizationId} = ${orgId}`)
      .limit(1),
    db.select({ id: inferenceCallRatingT.callId })
      .from(inferenceCallRatingT)
      .innerJoin(inferenceCallT, sql`${inferenceCallT.id} = ${inferenceCallRatingT.callId}`)
      .where(sql`${inferenceCallT.organizationId} = ${orgId}`)
      .limit(1),
  ]);
  return legacy.length > 0 || current.length > 0;
}

/** The export carries whichever rating a call has, regardless of who left it. */
export async function resolveFirstRating(callId: string): Promise<ApiCallResponse | undefined> {
  const db = getDB();
  const [[legacy], [current]] = await Promise.all([
    db.select().from(apiCallResponseT).where(sql`${apiCallResponseT.apiCallId} = ${callId}`).limit(1),
    db.select().from(inferenceCallRatingT).where(sql`${inferenceCallRatingT.callId} = ${callId}`).limit(1),
  ]);
  if (legacy) {
    return legacy;
  }
  if (!current) {
    return undefined;
  }
  const { callId: ratedCallId, verdict, ...rest } = current;
  return { ...rest, apiCallId: ratedCallId, response: verdict };
}
