/**
 * ORPC root configuration and shared middlewares.
 * Provides auth-aware context and common error mapping.
 */
import { auth, type Session } from "$lib/server/auth-server";
import { os } from "@orpc/server";
import { rootLogger } from "../logging";
import type { ac } from "../roles";
import { isInstanceAdmin } from "../serverenv";
import { runWithAudit, type ActorInfo, type AuditContext, type AuditTag } from "./audit";

/** Metadata type available on all dashboard procedures. */
export type ProcedureMeta = {
  /** Set to `false` to exclude this procedure from the MCP server endpoint. Defaults to included. */
  mcp?: boolean;
  /** Opt a procedure into the audit trail. The middleware emits one event per call. */
  audit?: AuditTag;
};

export const rootOs = os.$context<App.Locals>().$meta<ProcedureMeta>({}).errors({
  UNAUTHORIZED: {},
  BAD_REQUEST: { message: "Invalid request" },
  FORBIDDEN: { message: "You do not have permission to perform this action" },
  NOT_FOUND: { message: "Resource not found" },
  INTERNAL_SERVER_ERROR: { message: "An internal error occurred" },
});
const log = rootLogger.child({ name: "orpc.root" });

type Resource = keyof typeof ac.statements;
type Action<R extends Resource> = (typeof ac.statements)[R][number];
type PermissionSpec = { [R in Resource]?: Action<R>[] };

async function loadSessionOrThrow(
  context: App.Locals,
  errors: { UNAUTHORIZED: () => Error },
): Promise<Session> {
  const session = await auth.api.getSession({ headers: context.request.headers });
  if (!session) throw errors.UNAUTHORIZED();
  return session;
}

type ApiKeyInfo = { keyId: string; name: string | null; organizationId: string | null };

async function resolveApiKeyInfo(request: Request): Promise<ApiKeyInfo | null> {
  const apiKey = request.headers.get("x-api-key");
  if (!apiKey) return null;
  try {
    const result = await auth.api.verifyApiKey({ body: { key: apiKey } });
    if (result.valid && result.key?.id) {
      return {
        keyId: result.key.id,
        name: result.key.name ?? null,
        organizationId: (result.key.metadata?.organizationId as string) ?? null,
      };
    }
  } catch (err) {
    log.warn(err, "Failed to verify API key");
  }
  return null;
}

async function resolveActor(
  request: Request,
  session: Session,
  isInstanceAdmin = false,
): Promise<{ actor: ActorInfo; apiKeyInfo: ApiKeyInfo | null }> {
  const apiKeyInfo = await resolveApiKeyInfo(request);
  const actor: ActorInfo = apiKeyInfo
    ? { actorType: "api_key", actorId: apiKeyInfo.keyId, actorLabel: apiKeyInfo.name ?? apiKeyInfo.keyId }
    : { actorType: isInstanceAdmin ? "instance_admin" : "user", actorId: session.user.id, actorLabel: session.user.email };
  return { actor, apiKeyInfo };
}

/**
 * Require an authenticated session and attach it to the ORPC context.
 */
export const withAuth = rootOs.middleware(async ({ context, next, errors }) => {
  const session = await loadSessionOrThrow(context, errors);
  const { actor } = await resolveActor(context.request, session);
  return next({
    context: {
      ...context,
      session,
      actor,
    } as App.Locals & { session: Session; actor: ActorInfo },
  });
});

/**
 * Require an authenticated session with an active organization id.
 * For API key auth, falls back to the organizationId stored in the key's metadata.
 */
export const withOrganization = rootOs.middleware(async ({ context, next, errors }) => {
  const session = await loadSessionOrThrow(context, errors);
  const { actor, apiKeyInfo } = await resolveActor(context.request, session);

  const activeOrganizationId =
    session.session.activeOrganizationId ?? apiKeyInfo?.organizationId ?? null;

  if (!activeOrganizationId) {
    throw errors.UNAUTHORIZED({ message: "No organization is set to active" });
  }
  return next({
    context: {
      ...context,
      session,
      actor,
      activeOrganizationId,
    } as App.Locals & { session: Session; actor: ActorInfo; activeOrganizationId: string },
  });
});

/**
 * Require an authenticated session with instance admin privileges.
 */
export const withInstanceAdmin = rootOs.middleware(async ({ context, next, errors }) => {
  const session = await loadSessionOrThrow(context, errors);
  if (!isInstanceAdmin(session.user.email)) {
    throw errors.FORBIDDEN();
  }
  const { actor } = await resolveActor(context.request, session, true);
  return next({
    context: {
      ...context,
      session,
      actor,
    } as App.Locals & { session: Session; actor: ActorInfo },
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
    const rlog = log.child({ traceId: context.traceId });
    const result = await auth.api.hasPermission({
      headers: context.request.headers,
      body: {
        permissions,
        organizationId: context.activeOrganizationId,
      },
    });

    if (!result.success) {
      rlog.warn({ permissions, userId: context.session?.user?.id }, "Permission denied");
      throw errors.FORBIDDEN();
    }

    return next({ context });
  });
}

/**
 * Emits an audit event for procedures tagged with `.meta({ audit })`. No-op
 * otherwise. Runs after auth/org guards so actor and org are already on context.
 */
export const auditMiddleware = rootOs.middleware(({ context, procedure, next }) => {
  const ctx = context as AuditContext;
  return runWithAudit(ctx, procedure["~orpc"].meta.audit, () => next());
});
