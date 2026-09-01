/**
 * Reads `inference_call` conversations back into the flattened shape the Data view already
 * renders, so the two storage forms differ only here and not in the UI.
 */
import {
  chatMessageT,
  inferenceCallMessageT,
  apiCallT,
  sql,
  type ApiCallInputMessage,
  type MessageDirection,
  type SQL,
} from "common-db";
import { getDB } from "./db";

export type CallMessages = {
  inputMessages: ApiCallInputMessage[];
  outputMessage: ApiCallInputMessage | null;
};

export function escapeLikePattern(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

export function searchPattern(query: string): string {
  return `%${escapeLikePattern(query.trim())}%`;
}

/** A legacy call matches on the copies it carries. */
export function legacyMatchesSearch(pattern: string): SQL {
  return sql`(${apiCallT.inputMessages}::text ILIKE ${pattern} OR ${apiCallT.outputMessage}::text ILIKE ${pattern})`;
}

/** An `inference_call` matches on any message it references, so the term is checked against the
 * deduplicated corpus rather than a copy per call. */
export function callMatchesSearch(callId: SQL, pattern: string): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM ${inferenceCallMessageT}
    JOIN ${chatMessageT} ON ${chatMessageT.id} = ${inferenceCallMessageT.messageId}
    WHERE
      ${inferenceCallMessageT.callId} = ${callId}
    AND
      ${chatMessageT.body}::text ILIKE ${pattern}
  )`;
}

export type CallMessageRow = {
  callId: string;
  direction: MessageDirection;
  body: ApiCallInputMessage;
};

/** Rows arrive flat and ordered by `(call_id, seq)`; this is the fold back into per-call shape. */
export function groupCallMessages(rows: CallMessageRow[]): Map<string, CallMessages> {
  const resolved = new Map<string, CallMessages>();
  for (const row of rows) {
    const entry = resolved.get(row.callId) ?? { inputMessages: [], outputMessage: null };
    if (row.direction === "output") {
      entry.outputMessage = row.body;
    } else {
      entry.inputMessages.push(row.body);
    }
    resolved.set(row.callId, entry);
  }
  return resolved;
}

/** One query for a whole page, so listing calls does not fan out per row. */
export async function resolveCallMessages(callIds: string[]): Promise<Map<string, CallMessages>> {
  if (callIds.length === 0) {
    return new Map();
  }

  const rows = await getDB()
    .select({
      callId: inferenceCallMessageT.callId,
      direction: inferenceCallMessageT.direction,
      body: chatMessageT.body,
    })
    .from(inferenceCallMessageT)
    .innerJoin(chatMessageT, sql`${chatMessageT.id} = ${inferenceCallMessageT.messageId}`)
    .where(sql`${inferenceCallMessageT.callId} IN (${sql.join(callIds.map((id) => sql`${id}`), sql`, `)})`)
    .orderBy(sql`${inferenceCallMessageT.callId}, ${inferenceCallMessageT.seq} ASC`);

  return groupCallMessages(rows);
}
