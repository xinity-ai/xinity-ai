/**
 * ORPC root configuration and shared middlewares.
 * Provides auth-aware context and common error mapping.
 */
import { auth, type Session } from "$lib/server/auth-server";
import { os } from "@orpc/server";
import { rootLogger } from "../logging";
import type { ac } from "../roles";
import { isInstanceAdmin } from "../serverenv";

/** Metadata type available on all dashboard procedures. */
export type ProcedureMeta = {
  /** Set to `false` to exclude this procedure from the MCP server endpoint. Defaults to included. */
  mcp?: boolean;
};

export const rootOs = os.$context<App.Locals>().$meta<ProcedureMeta>({}).errors({
  UNAUTHORIZED: {},
  FORBIDDEN: { message: "You do not have permission to perform this action" },
  NOT_FOUND: { message: "Resource not found" },
  INTERNAL_SERVER_ERROR: { message: "An internal error occurred" },
});
const log = rootLogger.child({ name: "orpc.root" });

type Resource = keyof typeof ac.statements;
type Action<R extends Resource> = (typeof ac.statements)[R][number];
type PermissionSpec = { [R in Resource]?: Action<R>[] };

/**
 * Require an authenticated session and attach it to the ORPC context.
 */
export const withAuth = rootOs.middleware(async ({ context, next, signal, errors }) => {
  const session = await auth.api.getSession(context.request);
  if (!session) {
    throw errors.UNAUTHORIZED();
  }
  return next({
    context: {
      ...context,
      session,
    } as App.Locals & { session: Session },
  });
});

/**
 * Require an authenticated session with an active organization id.
 * For API key auth, falls back to the organizationId stored in the key's metadata.
 */
export const withOrganization = rootOs.middleware(async ({ context, next, signal, errors }) => {
  const session = await auth.api.getSession(context.request);
  if (!session) {
    throw errors.UNAUTHORIZED();
  }

  let activeOrganizationId = session.session.activeOrganizationId;

  // For API key auth the synthetic session has no activeOrganizationId,
  // so resolve it from the key's metadata instead.
  if (!activeOrganizationId) {
    const apiKey = context.request.headers.get("x-api-key");
    if (apiKey) {
      try {
        const result = await auth.api.verifyApiKey({ body: { key: apiKey } });
        log.debug({ result }, "API key verification result");
        if (result.valid && result.key?.metadata?.organizationId) {
          activeOrganizationId = result.key.metadata.organizationId as string;
        }
      } catch (err) {
        log.warn(err, "Failed to verify API key for organization resolution");
      }
    }
  }

  if (!activeOrganizationId) {
    throw errors.UNAUTHORIZED({ message: "No organization is set to active" });
  }
  return next({
    context: {
      ...context,
      session,
      activeOrganizationId,
    } as App.Locals & { session: Session, activeOrganizationId: string },
  });
});

/**
 * Require an authenticated session with instance admin privileges.
 */
export const withInstanceAdmin = rootOs.middleware(async ({ context, next, errors }) => {
  const session = await auth.api.getSession(context.request);
  if (!session) {
    throw errors.UNAUTHORIZED();
  }
  if (!isInstanceAdmin(session.user.email)) {
    throw errors.FORBIDDEN();
  }
  return next({
    context: {
      ...context,
      session,
    } as App.Locals & { session: Session },
  });
});

/**
 * Create a middleware that requires specific permissions.
 * Must be used after withOrganization.
 */
export function requirePermission(permissions: PermissionSpec) {
  return rootOs.$context<App.Locals & {
    session: Session,
    activeOrganizationId: string,
  }>().middleware(async ({ context, next, errors }) => {
    const result = await auth.api.hasPermission({
      headers: context.request.headers,
      body: { 
        permissions,  
        organizationId: context.activeOrganizationId,
      },
    });

    if (!result.success) {
      log.warn({ permissions, userId: context.session?.user?.id }, "Permission denied");
      throw errors.FORBIDDEN();
    }

    return next({ context });
  });
}
