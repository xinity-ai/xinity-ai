import { error } from "@sveltejs/kit";
import { serverEnv } from "$lib/server/serverenv";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "gateway-proxy" });

/**
 * Fetches `${GATEWAY_URL}${path}`, returning the upstream Response unchanged
 * (non-2xx included, so the gateway's own error body passes through). A failed
 * connection becomes a 502/504 instead of an opaque 500; a client abort is
 * re-thrown so it stays a cancellation.
 */
export async function fetchGateway(
  path: string,
  init: RequestInit,
  traceId?: string,
): Promise<Response> {
  try {
    return await fetch(`${serverEnv.GATEWAY_URL}${path}`, init);
  } catch (err) {
    if (init.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw err;
    }
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    log.error({ err, path, code, traceId }, "Gateway request failed");
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
      error(504, "The inference gateway did not respond in time. Please try again.");
    }
    error(502, "Could not reach the inference gateway. It may be offline or restarting.");
  }
}
