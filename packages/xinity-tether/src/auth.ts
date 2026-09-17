import { verifyRequest, type VerifyFailure } from "common-env";
import { config } from "./config";

export function verifySignature(req: Request, path: string): VerifyFailure | null {
  const result = verifyRequest(
    config.tetherSecret,
    req.headers.get("authorization"),
    { method: req.method, path },
  );
  return result.ok ? null : result.reason;
}

/** Names the scheme, because a daemon predating it fails here rather than at the protocol check. */
export function unauthorized(reason: VerifyFailure): Response {
  const detail = reason === "stale"
    ? "Signature timestamp is outside the accepted window; check the clock on this node."
    : "Expected an Authorization header signed with the tether secret.";
  return new Response(`Unauthorized: ${detail}`, { status: 401 });
}
