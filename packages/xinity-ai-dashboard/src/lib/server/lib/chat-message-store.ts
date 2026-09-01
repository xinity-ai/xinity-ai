/**
 * Content-addressed storage for chat messages, so repeated history is stored once. Copied rather
 * than shared because the query needs `chatMessageT`, and common-env cannot depend on common-db.
 * The digest itself is the shared `jsonDigest`, so the two writers cannot disagree.
 */
import { apiResponseMessageT, chatMessageT, inArray, inferenceCallMessageT, sql, type ApiCallInputMessage } from "common-db";
import { jsonDigest } from "common-env";
import { getDB } from "../db";

type Database = ReturnType<typeof getDB>;
/** Lets callers commit messages together with the rows referencing them. */
export type ChatMessageStoreExecutor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Stores each message body once per organization and returns their row ids, one per input message
 * and in the same order. Repeats, within the batch and across calls, collapse onto one row.
 *
 * Reading conflicts back relies on per-statement snapshots: never run this at REPEATABLE READ or
 * above.
 */
export async function recordChatMessages(
  orgId: string,
  messages: ApiCallInputMessage[],
  executor: ChatMessageStoreExecutor = getDB(),
): Promise<string[]> {
  if (messages.length === 0) {
    return [];
  }

  const digests = messages.map(jsonDigest);
  const resolved = new Map<string, string>();
  const pending = new Map<string, ApiCallInputMessage>();

  for (const [index, sha256] of digests.entries()) {
    if (!resolved.has(sha256) && !pending.has(sha256)) {
      pending.set(sha256, messages[index]!);
    }
  }

  const inserted = await executor
    .insert(chatMessageT)
    .values([...pending].map(([sha256, body]) => ({ organizationId: orgId, sha256, body })))
    // DO NOTHING, not a no-op DO UPDATE, which would write a dead tuple per repeat.
    .onConflictDoNothing()
    .returning({ id: chatMessageT.id, sha256: chatMessageT.sha256 });

  for (const row of inserted) {
    resolved.set(row.sha256, row.id);
  }

  const conflicted = [...pending.keys()].filter((sha256) => !resolved.has(sha256));
  if (conflicted.length > 0) {
    const existing = await executor
      .select({ id: chatMessageT.id, sha256: chatMessageT.sha256 })
      .from(chatMessageT)
      .where(sql`
        ${chatMessageT.organizationId} = ${orgId}
      AND
        ${inArray(chatMessageT.sha256, conflicted)}
      `);
    for (const row of existing) {
      resolved.set(row.sha256, row.id);
    }
  }

  return digests.map((sha256) => {
    const id = resolved.get(sha256);
    if (!id) {
      throw new Error(`Failed to record message ${sha256}`);
    }
    return id;
  });
}

/**
 * Removes bodies nothing references any more. Deleting a call takes its link rows with it, so the
 * ids have to be gathered before that delete and handed here after it, inside the same transaction.
 *
 * A body shared with a call that survives is kept, which is the whole point of storing it once.
 */
export async function pruneUnreferencedMessages(
  messageIds: string[],
  executor: ChatMessageStoreExecutor = getDB(),
): Promise<number> {
  if (messageIds.length === 0) {
    return 0;
  }

  const removed = await executor
    .delete(chatMessageT)
    .where(sql`
      ${inArray(chatMessageT.id, messageIds)}
    AND NOT EXISTS (
      SELECT 1 FROM ${inferenceCallMessageT}
      WHERE ${inferenceCallMessageT.messageId} = ${chatMessageT.id}
    )
    AND NOT EXISTS (
      SELECT 1 FROM ${apiResponseMessageT}
      WHERE ${apiResponseMessageT.messageId} = ${chatMessageT.id}
    )
    `)
    .returning({ id: chatMessageT.id });

  return removed.length;
}

/** Ids the given calls reference, gathered before deleting them so they can be pruned after. */
export async function messageIdsOfCalls(
  callIds: string[],
  executor: ChatMessageStoreExecutor = getDB(),
): Promise<string[]> {
  if (callIds.length === 0) {
    return [];
  }
  const rows = await executor
    .selectDistinct({ id: inferenceCallMessageT.messageId })
    .from(inferenceCallMessageT)
    .where(inArray(inferenceCallMessageT.callId, callIds));
  return rows.map((row) => row.id);
}
