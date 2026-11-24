import {
  and,
  eq,
  inArray,
  inferenceCallT,
  inferenceCallMediaT,
  inferenceCallMessageT,
  mediaObjectT,
  type ApiCallInputMessage,
  type InferenceEndpoint,
  type MessageDirection,
} from "common-db";
import { getDB } from "./db";
import { recordChatMessages, type ChatMessageStoreExecutor } from "./chat-message-store";
import { rootLogger } from "./logger";

const log = rootLogger.child({ name: "inference-call-store" });

export type InferenceCallRecord = {
  /** Set when a caller needed the id before the batch was flushed. */
  id?: string;
  organizationId: string;
  apiKeyId: string | null;
  applicationId: string | null;
  endpoint: InferenceEndpoint;
  servedModel: string;
  publicSpecifier: string;
  user?: string | null;
  durationMs: number;
  metadata?: Record<string, unknown>;
  inputMessages: ApiCallInputMessage[];
  outputMessages: ApiCallInputMessage[];
  outputMediaDigests?: string[];
};

type PendingMessage = {
  callIndex: number;
  seq: number;
  direction: MessageDirection;
  message: ApiCallInputMessage;
};

function pendingMessages(calls: InferenceCallRecord[]): PendingMessage[] {
  return calls.flatMap((call, callIndex) => [
    ...call.inputMessages.map((message, seq) => ({
      callIndex,
      seq,
      direction: "input" as const,
      message,
    })),
    ...call.outputMessages.map((message, offset) => ({
      callIndex,
      seq: call.inputMessages.length + offset,
      direction: "output" as const,
      message,
    })),
  ]);
}

function groupByOrg(
  calls: InferenceCallRecord[],
  pending: PendingMessage[],
): Map<string, PendingMessage[]> {
  const groups = new Map<string, PendingMessage[]>();
  for (const entry of pending) {
    const orgId = calls[entry.callIndex]!.organizationId;
    const group = groups.get(orgId);
    if (group) {
      group.push(entry);
    } else {
      groups.set(orgId, [entry]);
    }
  }
  return groups;
}

function toCallRow(call: InferenceCallRecord, id: string) {
  return {
    id,
    organizationId: call.organizationId,
    apiKeyId: call.apiKeyId,
    applicationId: call.applicationId,
    endpoint: call.endpoint,
    servedModel: call.servedModel,
    publicSpecifier: call.publicSpecifier,
    user: call.user ?? null,
    durationMs: call.durationMs,
    metadata: call.metadata ?? {},
  };
}

/** Ids in the order given. */
export async function recordInferenceCalls(calls: InferenceCallRecord[]): Promise<string[]> {
  if (calls.length === 0) {
    return [];
  }

  const ids = calls.map((call) => call.id ?? crypto.randomUUID());
  const pending = pendingMessages(calls);

  await getDB().transaction(async (tx) => {
    await tx.insert(inferenceCallT).values(calls.map((call, index) => toCallRow(call, ids[index]!)));

    const rows = [];
    for (const [orgId, group] of groupByOrg(calls, pending)) {
      const messageIds = await recordChatMessages(orgId, group.map((entry) => entry.message), tx);
      rows.push(...group.map((entry, index) => ({
        callId: ids[entry.callIndex]!,
        seq: entry.seq,
        messageId: messageIds[index]!,
        direction: entry.direction,
      })));
    }

    if (rows.length > 0) {
      await tx.insert(inferenceCallMessageT).values(rows);
    }

    const mediaRows = await outputMediaRows(calls, ids, tx);
    if (mediaRows.length > 0) {
      await tx.insert(inferenceCallMediaT).values(mediaRows);
    }
  });

  return ids;
}

async function outputMediaRows(calls: InferenceCallRecord[], ids: string[], tx: ChatMessageStoreExecutor) {
  const rows: { callId: string; seq: number; mediaObjectId: string }[] = [];
  for (const [index, call] of calls.entries()) {
    const digests = call.outputMediaDigests ?? [];
    if (digests.length === 0) {
      continue;
    }
    const stored = await tx
      .select({ id: mediaObjectT.id, sha256: mediaObjectT.sha256 })
      .from(mediaObjectT)
      .where(and(eq(mediaObjectT.organizationId, call.organizationId), inArray(mediaObjectT.sha256, digests)));
    const idByDigest = new Map(stored.map((row) => [row.sha256, row.id]));
    for (const [seq, digest] of digests.entries()) {
      const mediaObjectId = idByDigest.get(digest);
      if (mediaObjectId) {
        rows.push({ callId: ids[index]!, seq, mediaObjectId });
      } else {
        log.warn({ callId: ids[index], digest }, "Output media was not stored, logging the call without it");
      }
    }
  }
  return rows;
}
