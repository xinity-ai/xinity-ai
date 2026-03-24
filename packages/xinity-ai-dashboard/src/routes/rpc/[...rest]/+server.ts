/**
 * ORPC fetch handler for `/rpc` endpoints.
 */
import { RPCHandler, BodyLimitPlugin } from "@orpc/server/fetch";
import { router } from "$lib/server/orpc/router";
import type { RequestHandler } from "./$types";
import { onError, ORPCError } from "@orpc/server";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "orpc.rpc.root" })

/**
 * Creates the RPC handler with body size limits.
 */
const handler = new RPCHandler<App.Locals>(router, {
  plugins: [new BodyLimitPlugin({ maxBodySize: 1024 * 1024 })],
  interceptors: [
    onError(err => {
      if (err instanceof ORPCError) {
        log.debug(err, "Accepted error during orpc call")
      } else {
        log.error(err, "Error during ORPC Call handling")
      }
    }),
  ],
});

/** Handles RPC requests and returns a 404 when no route matches. */
const handle: RequestHandler = async ({ request, locals }) => {
  const { response } = await handler.handle(request, {
    prefix: "/rpc",
    context: locals,
  });

  return response ?? new Response("Not Found", { status: 404 });
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
