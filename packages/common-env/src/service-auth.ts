import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SCHEME = "Xinity";
const MAX_SKEW_MS = 60_000;

export type SignedRequest = {
  method: string;
  /** Path and query, so a signature cannot be re-pointed at another endpoint. */
  path: string;
  body?: string;
};

export type VerifyFailure = "missing" | "malformed" | "stale" | "mismatch";
export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

function canonical(request: SignedRequest, timestamp: number, nonce: string): string {
  return [
    request.method.toUpperCase(),
    request.path,
    String(timestamp),
    nonce,
    createHash("sha256").update(request.body ?? "").digest("base64url"),
  ].join("\n");
}

function mac(secret: string, request: SignedRequest, timestamp: number, nonce: string): string {
  return createHmac("sha256", secret).update(canonical(request, timestamp, nonce)).digest("base64url");
}

/**
 * Proves the caller holds the shared secret without putting it on the wire. The method, path and
 * body are signed too, so a captured header cannot be re-pointed at a different request.
 */
export function signRequest(secret: string, request: SignedRequest): string {
  const timestamp = Date.now();
  const nonce = randomBytes(16).toString("base64url");
  return `${SCHEME} ts=${timestamp},nonce=${nonce},mac=${mac(secret, request, timestamp, nonce)}`;
}

function parseHeader(header: string): { timestamp: number; nonce: string; mac: string } | null {
  if (!header.startsWith(`${SCHEME} `)) {
    return null;
  }

  const parts = new Map(
    header.slice(SCHEME.length + 1).split(",").map((pair) => {
      const at = pair.indexOf("=");
      return at === -1 ? ["", ""] : [pair.slice(0, at).trim(), pair.slice(at + 1).trim()];
    }),
  );

  const timestamp = Number(parts.get("ts"));
  const nonce = parts.get("nonce");
  const presented = parts.get("mac");
  if (!Number.isSafeInteger(timestamp) || !nonce || !presented) {
    return null;
  }
  return { timestamp, nonce, mac: presented };
}

/**
 * A stale result is reported apart from a mismatch: an unsynchronised clock and a wrong secret are
 * indistinguishable from the caller's side and take entirely different fixes.
 */
export function verifyRequest(
  secret: string,
  header: string | null,
  request: SignedRequest,
  now = Date.now(),
): VerifyResult {
  if (!header) {
    return { ok: false, reason: "missing" };
  }

  const parsed = parseHeader(header);
  if (!parsed) {
    return { ok: false, reason: "malformed" };
  }

  if (Math.abs(now - parsed.timestamp) > MAX_SKEW_MS) {
    return { ok: false, reason: "stale" };
  }

  const expected = Buffer.from(mac(secret, request, parsed.timestamp, parsed.nonce));
  const presented = Buffer.from(parsed.mac);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}
