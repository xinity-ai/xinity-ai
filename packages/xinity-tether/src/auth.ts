import { createRequestVerifier, type VerifyFailure } from "common-env";
import { config } from "./config";

const verifyOnce = createRequestVerifier();

export function verifySignature(req: Request, path: string): VerifyFailure | null {
  const result = verifyOnce(
    config.tetherSecret,
    req.headers.get("authorization"),
    { method: req.method, path },
  );
  return result.ok ? null : result.reason;
}

function refusalDetail(reason: VerifyFailure): string {
  switch (reason) {
    case "stale":
      return `Signature timestamp is outside the accepted window. This tether's clock reads ${new Date().toISOString()}. Compare it with the clock on the calling node.`;
    case "replayed":
      return "This signature was already used. Every request has to be signed anew.";
    default:
      return "Expected an Authorization header signed with the tether secret.";
  }
}

/** Names the scheme, because a daemon predating it fails here rather than at the protocol check. */
export function unauthorizedDetail(reason: VerifyFailure): string {
  return `Unauthorized: ${refusalDetail(reason)}`;
}
