/** Durable storage for responses, backing retrieval once Redis has expired them. */
import {
  apiResponseT,
  apiResponseItemT,
  apiResponseMessageT,
  apiResponseStatusEnum,
  chatMessageT,
  type ApiResponseStatus,
  type ApiResponseSettledStatus,
  type ApiCallInputMessage,
  type ApiResponse,
  sql,
} from "common-db";
import { getDB } from "../../db";
import { resolveChatMessageIds } from "../../chat-message-store";
import type { OutputItem, ResponseObject } from "./schemas";

/** Fields the header stores as columns, so they must not also live in `requestParams`. */
const COLUMN_BACKED_FIELDS = ["id", "object", "created_at", "status", "completed_at", "error", "incomplete_details", "output", "usage", "model", "previous_response_id"] as const;

const SETTLED_STATUSES = new Set<string>(
  apiResponseStatusEnum.enumValues.filter((status) => status !== "in_progress"),
);

export function isSettledStatus(status: string): status is ApiResponseSettledStatus {
  return SETTLED_STATUSES.has(status);
}

function toRequestParams(response: ResponseObject): Record<string, unknown> {
  const params: Record<string, unknown> = { ...response };
  for (const field of COLUMN_BACKED_FIELDS) {
    delete params[field];
  }
  return params;
}

export type ResponseOwner = {
  orgId: string;
  apiKeyId: string | null;
  applicationId: string | null;
};

export function toResponseRow(
  response: ResponseObject,
  status: ApiResponseStatus,
  owner: ResponseOwner,
): typeof apiResponseT.$inferInsert {
  return {
    id: response.id,
    organizationId: owner.orgId,
    apiKeyId: owner.apiKeyId,
    applicationId: owner.applicationId,
    model: response.model,
    status,
    previousResponseId: response.previous_response_id,
    requestParams: toRequestParams(response),
    error: response.error,
    incompleteDetails: response.incomplete_details,
    usage: response.usage as Record<string, unknown> | null,
    completedAt: response.completed_at === null ? null : new Date(response.completed_at * 1000),
    createdAt: new Date(response.created_at * 1000),
  };
}

export function fromResponseRow(
  header: ApiResponse,
  items: OutputItem[],
): ResponseObject {
  return {
    ...header.requestParams,
    id: header.id,
    object: "response",
    created_at: Math.floor(header.createdAt.getTime() / 1000),
    status: header.status,
    completed_at: header.completedAt === null ? null : Math.floor(header.completedAt.getTime() / 1000),
    error: header.error ?? null,
    incomplete_details: header.incompleteDetails ?? null,
    model: header.model,
    previous_response_id: header.previousResponseId,
    output: items,
    usage: header.usage ?? null,
  } as ResponseObject;
}

function toItemRows(responseId: string, output: OutputItem[]) {
  return output.map((item, seq) => ({
    responseId,
    seq,
    itemId: item.id,
    type: item.type,
    payload: item as unknown as Record<string, unknown>,
  }));
}

export type CreatePersistedResponseArgs = ResponseOwner & {
  response: ResponseObject;
  inputMessages: ApiCallInputMessage[];
};

/**
 * Records the request and its input. Runs in one transaction so a response is never
 * visible without the messages it was built from.
 */
export async function createPersistedResponse(args: CreatePersistedResponseArgs): Promise<void> {
  const { response, orgId, apiKeyId, applicationId, inputMessages } = args;

  await getDB().transaction(async (tx) => {
    const inserted = await tx
      .insert(apiResponseT)
      .values(toResponseRow(response, "in_progress", { orgId, apiKeyId, applicationId }))
      .onConflictDoNothing()
      .returning({ id: apiResponseT.id });

    if (inserted.length === 0) {
      return;
    }

    const messageIds = await resolveChatMessageIds(orgId, inputMessages, tx);
    if (messageIds.length > 0) {
      await tx.insert(apiResponseMessageT).values(
        messageIds.map((messageId, seq) => ({ responseId: response.id, seq, messageId })),
      );
    }
  });
}

/**
 * The one update a response ever receives. Conditioning it on `in_progress` means a late
 * completion cannot overwrite a cancellation, and item rows cannot be inserted twice.
 * Returns false when the row was already settled or was never stored.
 */
export async function settlePersistedResponse(orgId: string, response: ResponseObject): Promise<boolean> {
  const status = response.status;
  if (!isSettledStatus(status)) {
    throw new Error(`Refusing to settle response ${response.id} as ${status}`);
  }

  return getDB().transaction(async (tx) => {
    const settled = await tx
      .update(apiResponseT)
      .set({
        status,
        error: response.error,
        incompleteDetails: response.incomplete_details,
        usage: response.usage as Record<string, unknown> | null,
        completedAt: response.completed_at === null ? null : new Date(response.completed_at * 1000),
      })
      .where(
        sql`
          ${apiResponseT.id} = ${response.id}
        AND
          ${apiResponseT.organizationId} = ${orgId}
        AND
          ${apiResponseT.status} = 'in_progress'
        `,
      )
      .returning({ id: apiResponseT.id });

    if (settled.length === 0) {
      return false;
    }

    const items = toItemRows(response.id, response.output);
    if (items.length > 0) {
      await tx.insert(apiResponseItemT).values(items);
    }
    return true;
  });
}

export async function loadResponse(orgId: string, responseId: string): Promise<ResponseObject | null> {
  const db = getDB();
  const [header] = await db
    .select()
    .from(apiResponseT)
    .where(
      sql`
        ${apiResponseT.id} = ${responseId}
      AND
        ${apiResponseT.organizationId} = ${orgId}
      `,
    )
    .limit(1);
  if (!header) {
    return null;
  }

  const items = await db
    .select({ payload: apiResponseItemT.payload })
    .from(apiResponseItemT)
    .where(sql`${apiResponseItemT.responseId} = ${responseId}`)
    .orderBy(sql`${apiResponseItemT.seq} ASC`);

  return fromResponseRow(header, items.map((row) => row.payload as unknown as OutputItem));
}

export type InputItemPage = {
  messages: Array<{ seq: number; payload: ApiCallInputMessage }>;
  hasMore: boolean;
};

/**
 * Reads one page of the input a response was built from. Fetches one row beyond the limit
 * to answer `has_more` without a second count query.
 */
export async function loadResponseInputItems(
  orgId: string,
  responseId: string,
  page: { limit: number; ascending: boolean; afterSeq: number | null },
): Promise<InputItemPage> {
  const { limit, ascending, afterSeq } = page;
  const rows = await getDB()
    .select({ seq: apiResponseMessageT.seq, payload: chatMessageT.payload })
    .from(apiResponseMessageT)
    .innerJoin(chatMessageT, sql`${chatMessageT.id} = ${apiResponseMessageT.messageId}`)
    .innerJoin(apiResponseT, sql`${apiResponseT.id} = ${apiResponseMessageT.responseId}`)
    .where(
      sql`
        ${apiResponseMessageT.responseId} = ${responseId}
      AND
        ${apiResponseT.organizationId} = ${orgId}
      ${afterSeq === null
        ? sql``
        : ascending
          ? sql`AND ${apiResponseMessageT.seq} > ${afterSeq}`
          : sql`AND ${apiResponseMessageT.seq} < ${afterSeq}`}
      `,
    )
    .orderBy(ascending ? sql`${apiResponseMessageT.seq} ASC` : sql`${apiResponseMessageT.seq} DESC`)
    .limit(limit + 1);

  return { messages: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function deletePersistedResponse(orgId: string, responseId: string): Promise<void> {
  await getDB()
    .delete(apiResponseT)
    .where(
      sql`
        ${apiResponseT.id} = ${responseId}
      AND
        ${apiResponseT.organizationId} = ${orgId}
      `
    );
}
