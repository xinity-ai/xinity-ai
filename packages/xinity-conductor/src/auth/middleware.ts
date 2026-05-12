import { validateToken, type RunnerIdentity } from "./token";

/** Extracts and validates the Bearer token from a request. Returns the identity, or null on missing/invalid. */
export async function authenticate(req: Request): Promise<RunnerIdentity | null> {
  const header = req.headers.get("authorization");
  if (!header) {
    return null;
  }
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) {
    return null;
  }
  return validateToken(value);
}

/** Wraps a handler so it only runs when the request carries a valid runner token. */
export function withRunnerAuth(handler: (req: Request, identity: RunnerIdentity) => Response | Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const identity = await authenticate(req);
    if (!identity) {
      return new Response("Unauthorized", { status: 401 });
    }
    return handler(req, identity);
  };
}
