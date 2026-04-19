import type { Handle, HandleServerError } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { rootLogger } from "$lib/server/logging";
import { httpRequestCountMetric } from "$lib/server/metrics";
import { auth } from "$lib/server/auth-server";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { building } from "$app/environment";
import { startDeploymentSyncService } from "$lib/server/lib/orchestration.mod";
import { startNotificationScheduler } from "$lib/server/notifications/scheduler";
import { serverEnv } from "$lib/server/serverenv";
import { checkMigrationState, isMigrationOk } from "$lib/server/migration-check";

const log = rootLogger.child({ name: "hooks" });

/**
 * Verify database migrations are up to date before serving any requests.
 */
await checkMigrationState();

/**
 * Redirects all page requests to /migration-error/ when migrations are outdated.
 * API, RPC, metrics, and static asset paths are allowed through.
 */
const migrationGuard: Handle = ({ event, resolve }) => {
  if (!isMigrationOk()) {
    const path = event.url.pathname;
    const allowed =
      path.startsWith("/migration-error") ||
      path.startsWith("/api/") ||
      path.startsWith("/rpc/") ||
      path.startsWith("/metrics") ||
      path.startsWith("/log") ||
      path.startsWith("/_app/");

    if (!allowed) {
      redirect(302, "/migration-error/");
    }
  }
  return resolve(event);
};

/**
 * Populates shared locals for downstream server code.
 */
const fillLocals: Handle = ({ event, resolve }) => {
  event.locals.request = event.request;
  let incoming = event.request.headers.get("x-trace-id");
  if(incoming && incoming.length > 300){
    incoming = incoming.slice(0, 300);
  }
  const traceId = incoming || `trc_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  event.locals.traceId = traceId;
  return resolve(event);
};
/**
 * Delegates auth session handling to Better Auth's SvelteKit integration.
 */
const handleAuth: Handle = ({ event, resolve }) => {
  return svelteKitHandler({ event, resolve, auth, building });
};

/**
 * Combined handler chain.
 */
export const handle: Handle = sequence(migrationGuard, fillLocals, handleAuth, ({ event, resolve }) => {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  httpRequestCountMetric.inc({
    method: event.request.method,
    route: event.url.pathname.replace(uuid, "[uuid]"),
  });
  return resolve(event);
});

/**
 * Catch unexpected errors so they don't crash the process.
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
  const traceId = event.locals.traceId;
  log.error({ err: error, path: event?.url?.pathname, status, traceId }, "Unhandled server error");
  return { message: message ?? "Internal error", traceId };
};

/**
 * Start the deployment sync service when the server boots.
 * Gated by COMPUTE_MANAGEMENT_ENABLED; skip when running without local inference nodes.
 */
if (isMigrationOk() && serverEnv.COMPUTE_MANAGEMENT_ENABLED) {
  void startDeploymentSyncService();
}

/**
 * Start the notification scheduler (deployment status, node health, capacity, weekly reports).
 */
if (isMigrationOk() && serverEnv.NOTIFICATIONS_ENABLED) {
  void startNotificationScheduler();
}
