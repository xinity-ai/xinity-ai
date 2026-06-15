/**
 * Shared infoserver client instance for dashboard server-side code.
 */
import { building } from "$app/environment";
import { createInfoserverClient } from "xinity-infoserver";
import { serverEnv } from "./serverenv";
import { rootLogger } from "./logging";

export const infoClient = building ? null : createInfoserverClient({
  baseUrl: serverEnv.INFOSERVER_URL,
  cacheTtlMs: serverEnv.INFOSERVER_CACHE_TTL_MS,
  logger: rootLogger.child({ name: "infoserver-client" }),
});
