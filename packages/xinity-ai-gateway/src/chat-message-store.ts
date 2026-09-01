/** Content-addressed storage for chat messages, so repeated history is stored once. */
import { chatMessageT, sql, type ApiCallInputMessage } from "common-db";
import { jsonDigest } from "common-env";
import { getDB } from "./db";

const DIGEST_CACHE_MAX_ENTRIES = 5_000;

type Database = ReturnType<typeof getDB>;
/** Lets callers commit messages together with the rows referencing them. */
export type ChatMessageStoreExecutor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

function createDigestCache(maxEntries: number) {
  const entries = new Map<string, string>();
  return {
    get(key: string): string | undefined {
      const value = entries.get(key);
      if (value === undefined) {
        return undefined;
      }
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key: string, value: string): void {
      if (entries.has(key)) {
        entries.delete(key);
      } else if (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) {
          entries.delete(oldest);
        }
      }
      entries.set(key, value);
    },
  };
}

const digestCache = createDigestCache(DIGEST_CACHE_MAX_ENTRIES);

const cacheKey = (orgId: string, sha256: string) => `${orgId}:${sha256}`;

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
    if (resolved.has(sha256) || pending.has(sha256)) {
      continue;
    }
    const cached = digestCache.get(cacheKey(orgId, sha256));
    if (cached) {
      resolved.set(sha256, cached);
      continue;
    }
    pending.set(sha256, messages[index]!);
  }

  if (pending.size > 0) {
    const inserted = await executor
      .insert(chatMessageT)
      .values([...pending].map(([sha256, body]) => ({
        organizationId: orgId,
        sha256,
        body,
      })))
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
        .where(
          sql`
            ${chatMessageT.organizationId} = ${orgId}
          AND
            ${chatMessageT.sha256} IN (${sql.join(conflicted.map((sha256) => sql`${sha256}`), sql`, `)})
          `,
        );
      for (const row of existing) {
        resolved.set(row.sha256, row.id);
      }
    }
  }

  return digests.map((sha256) => {
    const id = resolved.get(sha256);
    if (!id) {
      throw new Error(`Failed to record message ${sha256}`);
    }
    digestCache.set(cacheKey(orgId, sha256), id);
    return id;
  });
}
