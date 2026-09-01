import {
  inferenceCallT,
  inferenceCallMessageT,
  type ApiCallInputMessage,
  type InferenceEndpoint,
  type MessageDirection,
} from "common-db";
import { getDB } from "./db";
import { recordChatMessages } from "./chat-message-store";

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
  });

  return ids;
}
