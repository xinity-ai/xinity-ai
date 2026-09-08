import type { Server } from "bun";

export type RouteHandler = (req: Request, server: Server<unknown>) => Promise<Response> | Response;

/** paths whose backend generation can outrun bun's 255s connection cap, and are bounded by BACKEND_TIMEOUT_MS instead */
export const LONG_RUNNING_ROUTES = new Set([
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/audio/transcriptions",
]);

/** lifts the connection timeout for one request; bun clamps per-request values to the 255s cap, so 0 is the only value that works */
export function withoutConnectionTimeout(handler: RouteHandler): RouteHandler {
  return (req, server) => {
    server.timeout(req, 0);
    return handler(req, server);
  };
}
