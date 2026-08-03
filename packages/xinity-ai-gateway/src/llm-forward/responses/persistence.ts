/** Durable storage for responses, backing retrieval once Redis has expired them. */
import {
  apiResponseT,
  apiResponseItemT,
  apiResponseMessageT,
  and,
  eq,
  asc,
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

const SETTLED_STATUSES = new Set<string>(["completed", "failed", "incomplete", "cancelled"]);

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
export async function settlePersistedResponse(response: ResponseObject): Promise<boolean> {
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
      .where(and(eq(apiResponseT.id, response.id), eq(apiResponseT.status, "in_progress")))
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
    .orderBy(asc(apiResponseItemT.seq));

  return fromResponseRow(header, items.map((row) => row.payload as unknown as OutputItem));
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
