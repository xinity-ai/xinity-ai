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
import { formatResponseId, parseResponseId } from "./response-id";
import { outputAsMessages } from "./input-normalize";
import type { OutputItem, ResponseObject } from "./schemas";

/** Fields the header stores as columns, so they must not also live in `requestParams`. */
const COLUMN_BACKED_FIELDS = ["id", "object", "created_at", "status", "completed_at", "error", "incomplete_details", "output", "usage", "model", "previous_response_id"] as const;

const SETTLED_STATUSES = new Set<string>(
  apiResponseStatusEnum.enumValues.filter((status) => status !== "in_progress"),
);

export function isSettledStatus(status: string): status is ApiResponseSettledStatus {
  return SETTLED_STATUSES.has(status);
}

/** The gateway generates every id it writes, so a malformed one here is a bug rather than bad input. */
function storedId(id: string): string {
  const uuid = parseResponseId(id);
  if (uuid === null) {
    throw new Error(`Malformed response id: ${id}`);
  }
  return uuid;
}

function toRequestParams(response: ResponseObject): Record<string, unknown> {
  const params: Record<string, unknown> = { ...response };
  for (const field of COLUMN_BACKED_FIELDS) {
    delete params[field];
  }
  return params;
}

export type ResponseAttribution = {
  apiKeyId: string | null;
  applicationId: string | null;
  inferenceCallId: string | null;
};

export type ResponseOwner = ResponseAttribution & { orgId: string };

export function toResponseRow(
  response: ResponseObject,
  status: ApiResponseStatus,
  owner: ResponseOwner,
): typeof apiResponseT.$inferInsert {
  return {
    id: storedId(response.id),
    organizationId: owner.orgId,
    apiKeyId: owner.apiKeyId,
    applicationId: owner.applicationId,
    model: response.model,
    status,
    previousResponseId: response.previous_response_id === null || response.previous_response_id === undefined
      ? null
      : parseResponseId(response.previous_response_id),
    requestParams: toRequestParams(response),
    error: response.error,
    incompleteDetails: response.incomplete_details,
    usage: response.usage as Record<string, unknown> | null,
    completedAt: response.completed_at === null ? null : new Date(response.completed_at * 1000),
    inferenceCallId: owner.inferenceCallId,
    createdAt: new Date(response.created_at * 1000),
  };
}

export function fromResponseRow(
  header: ApiResponse,
  items: OutputItem[],
): ResponseObject {
  return {
    ...header.requestParams,
    id: formatResponseId(header.id),
    object: "response",
    created_at: Math.floor(header.createdAt.getTime() / 1000),
    status: header.status,
    completed_at: header.completedAt === null ? null : Math.floor(header.completedAt.getTime() / 1000),
    error: header.error ?? null,
    incomplete_details: header.incompleteDetails ?? null,
    model: header.model,
    previous_response_id: header.previousResponseId === null ? null : formatResponseId(header.previousResponseId),
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
  const { response, orgId, apiKeyId, applicationId, inferenceCallId, inputMessages } = args;

  await getDB().transaction(async (tx) => {
    const inserted = await tx
      .insert(apiResponseT)
      .values(toResponseRow(response, "in_progress", { orgId, apiKeyId, applicationId, inferenceCallId }))
      .onConflictDoNothing()
      .returning({ id: apiResponseT.id });

    if (inserted.length === 0) {
      return;
    }

    const messageIds = await resolveChatMessageIds(orgId, inputMessages, tx);
    if (messageIds.length > 0) {
      await tx.insert(apiResponseMessageT).values(
        messageIds.map((messageId, seq) => ({
          responseId: storedId(response.id),
          seq,
          messageId,
          direction: "input" as const,
        })),
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
          ${apiResponseT.id} = ${storedId(response.id)}
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

    const id = storedId(response.id);
    const items = toItemRows(id, response.output);
    if (items.length > 0) {
      await tx.insert(apiResponseItemT).values(items);
    }

    // Converted once here rather than on every chained read, so the form a later turn replays
    // is the one that was stored, not one re-derived from the output items each time.
    const reply = outputAsMessages(response);
    if (reply.length > 0) {
      const [row] = await tx
        .select({ next: sql<number>`COALESCE(MAX(${apiResponseMessageT.seq}), -1) + 1` })
        .from(apiResponseMessageT)
        .where(sql`${apiResponseMessageT.responseId} = ${id}`);
      const firstSeq = row?.next ?? 0;

      const messageIds = await resolveChatMessageIds(orgId, reply, tx);
      await tx.insert(apiResponseMessageT).values(
        messageIds.map((messageId, offset) => ({
          responseId: id,
          seq: firstSeq + offset,
          messageId,
          direction: "output" as const,
        })),
      );
    }
    return true;
  });
}

export async function loadResponse(orgId: string, responseId: string): Promise<ResponseObject | null> {
  const id = parseResponseId(responseId);
  if (id === null) {
    return null;
  }

  const db = getDB();
  const [header] = await db
    .select()
    .from(apiResponseT)
    .where(
      sql`
        ${apiResponseT.id} = ${id}
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
    .where(sql`${apiResponseItemT.responseId} = ${id}`)
    .orderBy(sql`${apiResponseItemT.seq} ASC`);

  return fromResponseRow(header, items.map((row) => row.payload as unknown as OutputItem));
}

/** The whole conversation a response is part of, question and answer alike, in order. This is
 * what the next turn replays, which is why it does not stop at the input. */
export async function loadResponseMessages(
  orgId: string,
  responseId: string,
): Promise<ApiCallInputMessage[]> {
  const id = parseResponseId(responseId);
  if (id === null) {
    return [];
  }

  const rows = await getDB()
    .select({ body: chatMessageT.body })
    .from(apiResponseMessageT)
    .innerJoin(chatMessageT, sql`${chatMessageT.id} = ${apiResponseMessageT.messageId}`)
    .innerJoin(apiResponseT, sql`${apiResponseT.id} = ${apiResponseMessageT.responseId}`)
    .where(
      sql`
        ${apiResponseMessageT.responseId} = ${id}
      AND
        ${apiResponseT.organizationId} = ${orgId}
      `,
    )
    .orderBy(sql`${apiResponseMessageT.seq} ASC`);
  return rows.map((row) => row.body);
}

export type InputItemPage = {
  messages: Array<{ seq: number; body: ApiCallInputMessage }>;
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
  const id = parseResponseId(responseId);
  if (id === null) {
    return { messages: [], hasMore: false };
  }

  const { limit, ascending, afterSeq } = page;
  const rows = await getDB()
    .select({ seq: apiResponseMessageT.seq, body: chatMessageT.body })
    .from(apiResponseMessageT)
    .innerJoin(chatMessageT, sql`${chatMessageT.id} = ${apiResponseMessageT.messageId}`)
    .innerJoin(apiResponseT, sql`${apiResponseT.id} = ${apiResponseMessageT.responseId}`)
    .where(
      sql`
        ${apiResponseMessageT.responseId} = ${id}
      AND
        ${apiResponseMessageT.direction} = 'input'
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
  const id = parseResponseId(responseId);
  if (id === null) {
    return;
  }

  await getDB()
    .delete(apiResponseT)
    .where(
      sql`
        ${apiResponseT.id} = ${id}
      AND
        ${apiResponseT.organizationId} = ${orgId}
      `
    );
}
