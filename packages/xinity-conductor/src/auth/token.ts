import { and, eq, isNull, runnerTokenT } from "common-db";
import { getDB } from "../db";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "auth.token" });

export type RunnerIdentity = {
  tokenId: string;
  organizationId: string;
  name: string;
};

type CacheEntry =
  | { kind: "valid"; identity: RunnerIdentity; expiresAt: number }
  | { kind: "invalid"; expiresAt: number };

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

/**
 * Parse the prefix portion of a `xrt_<prefix>_<secret>` token. Returns null if the format is wrong.
 * The prefix uniquely identifies a row in `runnerTokenT`; the full plaintext is what argon2 verifies.
 */
function parsePrefix(plaintext: string): string | null {
  const parts = plaintext.split("_");
  if (parts.length < 3 || parts[0] !== "xrt") {
    return null;
  }
  return `${parts[0]}_${parts[1]}`;
}

/** Validate a plaintext token against the database. Returns the runner identity, or null if invalid/revoked. */
export async function validateToken(plaintext: string): Promise<RunnerIdentity | null> {
  const now = Date.now();
  const cached = cache.get(plaintext);
  if (cached && cached.expiresAt > now) {
    return cached.kind === "valid" ? cached.identity : null;
  }

  const prefix = parsePrefix(plaintext);
  if (!prefix) {
    cache.set(plaintext, { kind: "invalid", expiresAt: now + CACHE_TTL_MS });
    return null;
  }

  const [row] = await getDB()
    .select({
      id: runnerTokenT.id,
      organizationId: runnerTokenT.organizationId,
      name: runnerTokenT.name,
      hashedSecret: runnerTokenT.hashedSecret,
    })
    .from(runnerTokenT)
    .where(and(eq(runnerTokenT.prefix, prefix), isNull(runnerTokenT.deletedAt)))
    .limit(1);

  if (!row) {
    cache.set(plaintext, { kind: "invalid", expiresAt: now + CACHE_TTL_MS });
    return null;
  }

  const matches = await Bun.password.verify(plaintext, row.hashedSecret);
  if (!matches) {
    cache.set(plaintext, { kind: "invalid", expiresAt: now + CACHE_TTL_MS });
    return null;
  }

  const identity: RunnerIdentity = {
    tokenId: row.id,
    organizationId: row.organizationId,
    name: row.name,
  };
  cache.set(plaintext, { kind: "valid", identity, expiresAt: now + CACHE_TTL_MS });

  void touchLastSeen(row.id).catch((err) => {
    log.warn({ err, tokenId: row.id }, "Failed to update lastSeenAt");
  });

  return identity;
}

async function touchLastSeen(tokenId: string): Promise<void> {
  await getDB()
    .update(runnerTokenT)
    .set({ lastSeenAt: new Date() })
    .where(eq(runnerTokenT.id, tokenId));
}
