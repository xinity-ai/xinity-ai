/**
 * Converts `api_call` rows into `inference_call`, deleting each original in the same transaction.
 * That is what makes a re-run idempotent without a marker column.
 *
 * @deprecated Exists only to empty a table that is being dropped. Removed before 1.0.0.
 */
import {
  apiCallT,
  apiCallResponseT,
  inferenceCallT,
  inferenceCallMessageT,
  inferenceCallRatingT,
  sql,
  count,
  type ApiCall,
} from "common-db";
import { getDB } from "../db";
import { recordChatMessages } from "./chat-message-store";
import { rootLogger } from "../logging";

const log = rootLogger.child({ name: "legacy-postfill" });

export type PostfillProgress = {
  converted: number;
  failed: number;
  remaining: number;
};

export async function countLegacyCalls(): Promise<number> {
  const [row] = await getDB().select({ count: count() }).from(apiCallT);
  return row?.count ?? 0;
}

async function resolveChunkMessages(calls: ApiCall[]): Promise<Map<string, string[]>> {
  const byOrg = new Map<string, ApiCall[]>();
  for (const call of calls) {
    byOrg.set(call.organizationId, [...(byOrg.get(call.organizationId) ?? []), call]);
  }

  const idsByCall = new Map<string, string[]>();
  for (const [orgId, orgCalls] of byOrg) {
    const messages = orgCalls.flatMap((call) => [...call.inputMessages, call.outputMessage]);
    const ids = await recordChatMessages(orgId, messages);

    let offset = 0;
    for (const call of orgCalls) {
      const length = call.inputMessages.length + 1;
      idsByCall.set(call.id, ids.slice(offset, offset + length));
      offset += length;
    }
  }
  return idsByCall;
}

/** Ids arrive inputs first, then the output. */
export function callMessageRows(
  callId: string,
  inputCount: number,
  messageIds: string[],
): Array<{ callId: string; seq: number; messageId: string; direction: "input" | "output" }> {
  return messageIds.map((messageId, seq) => ({
    callId,
    seq,
    messageId,
    direction: seq === inputCount ? "output" : "input",
  }));
}

async function convertCall(call: ApiCall, messageIds: string[]): Promise<void> {
  await getDB().transaction(async (tx) => {
    await tx.insert(inferenceCallT).values({
      id: call.id,
      organizationId: call.organizationId,
      apiKeyId: call.apiKeyId,
      applicationId: call.applicationId,
      endpoint: "chat_completions",
      servedModel: call.model,
      publicSpecifier: call.specifiedModel,
      user: call.user,
      durationMs: call.duration,
      metadata: call.metadata ?? {},
      createdAt: call.createdAt,
    });

    await tx.insert(inferenceCallMessageT)
      .values(callMessageRows(call.id, call.inputMessages.length, messageIds));

    const ratings = await tx.select().from(apiCallResponseT)
      .where(sql`${apiCallResponseT.apiCallId} = ${call.id}`);

    if (ratings.length > 0) {
      await tx.insert(inferenceCallRatingT).values(ratings.map((rating) => ({
        callId: call.id,
        userId: rating.userId,
        verdict: rating.response,
        outputEdit: rating.outputEdit,
        highlights: rating.highlights ?? [],
        excludedMessages: rating.excludedMessages ?? [],
        inputExclusions: rating.inputExclusions ?? [],
        createdAt: rating.createdAt,
        updatedAt: rating.updatedAt,
      })));
    }

    // The cascade on api_call_response would take the labels, so it goes after they are copied.
    await tx.delete(apiCallT).where(sql`${apiCallT.id} = ${call.id}`);
  });
}

export async function postfillLegacyCalls(chunkSize: number): Promise<PostfillProgress> {
  const calls = await getDB().select().from(apiCallT).orderBy(apiCallT.createdAt).limit(chunkSize);
  if (calls.length === 0) {
    return { converted: 0, failed: 0, remaining: 0 };
  }

  const messageIds = await resolveChunkMessages(calls);

  let converted = 0;
  let failed = 0;
  for (const call of calls) {
    await convertCall(call, messageIds.get(call.id) ?? [])
      .then(() => { converted += 1; })
      .catch((err) => {
        failed += 1;
        log.error({ err, callId: call.id }, "Legacy call conversion failed");
      });
  }

  return { converted, failed, remaining: await countLegacyCalls() };
}
