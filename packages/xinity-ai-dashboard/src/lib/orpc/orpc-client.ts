/**
 * ORPC client wiring for browser/server usage.
 */
import type { RouterClient } from "@orpc/server";
import { createORPCClient, createSafeClient, type SafeClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { router } from "$lib/server/orpc/router";
import { browser } from "$app/environment";

/**
 * Creates an RPC link pointing at the local `/rpc` endpoint.
 */
const link = new RPCLink({
  url: ((browser && window.location.origin) || process.env.ORIGIN!) + "/rpc",
});

/**
 * Creates the typed ORPC client instance and wraps it in a safe client.
 */
const client: RouterClient<typeof router> = createORPCClient(link);
export const orpc: SafeClient<typeof client> = createSafeClient(client);
