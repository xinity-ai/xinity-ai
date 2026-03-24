/**
 * OpenAPI-compatible REST handler for ORPC procedures under `/api`.
 */
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import type { RequestHandler } from "./$types";
import { router } from "$lib/server/orpc/router";
import { onError, ORPCError } from "@orpc/server";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "orpc.api.root" });

const handler = new OpenAPIHandler<App.Locals>(router, {
  // plugins: [new BodyLimitPlugin({ maxBodySize: 1024 * 1024 })],
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

/** Handles OpenAPI requests and returns a 404 when no route matches. */
const handle: RequestHandler = async ({ request, locals }) => {
  const { response } = await handler.handle(request, {
    prefix: "/api",
    context: locals,
  });

  return response ?? new Response("Not Found", { status: 404 });
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
