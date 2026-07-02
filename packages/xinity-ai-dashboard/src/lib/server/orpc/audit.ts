/**
 * Audit-event emission. Best-effort writes wrapped so a logging failure can
 * never break the procedure that triggered them. The oRPC middleware that calls
 * `runWithAudit` lives in `root.ts`; the logic is kept here, free of oRPC imports.
 */
import { auth } from "$lib/server/auth-server";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { auditEventT, type AuditActorType } from "common-db";

const log = rootLogger.child({ name: "orpc.audit" });

export type AuditTag = { action: string; resource: string };

/** The subset of oRPC context the audit path reads. */
export type AuditContext = {
  request: Request;
  clientAddress?: string;
  session?: { user?: { id?: string | null } };
  activeOrganizationId?: string;
};

/** Only org-scoped procedures (via `withOrganization`) carry an org; instance/personal actions are null. */
function resolveOrg(context: AuditContext): string | null {
  return context.activeOrganizationId ?? null;
}

async function resolveActor(context: AuditContext): Promise<{ actorType: AuditActorType; actorId: string | null }> {
  const apiKey = context.request.headers.get("x-api-key");
  if (apiKey) {
    try {
      const result = await auth.api.verifyApiKey({ body: { key: apiKey } });
      if (result.valid && result.key?.id) return { actorType: "api_key", actorId: result.key.id };
    } catch (err) {
      log.warn(err, "Audit: API key verification failed during actor resolution");
    }
  }
  const userId = context.session?.user?.id;
  if (userId) return { actorType: "user", actorId: userId };
  return { actorType: "system", actorId: null };
}

export async function writeAuditEvent(row: typeof auditEventT.$inferInsert): Promise<void> {
  try {
    await getDB().insert(auditEventT).values(row);
  } catch (err) {
    log.warn({ err, action: row.action, resource: row.resource }, "Failed to write audit event");
  }
}

async function emitAudit(
  context: AuditContext,
  tag: AuditTag,
  org: string | null,
  result: "success" | "failure",
  extraContext?: Record<string, unknown>,
): Promise<void> {
  const actor = await resolveActor(context);
  await writeAuditEvent({
    organizationId: org,
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: tag.action,
    resource: tag.resource,
    result,
    ipAddress: context.clientAddress || null,
    userAgent: context.request.headers.get("user-agent"),
    context: extraContext,
  });
}

/**
 * Runs `next`, then emits one audit event reflecting the outcome. A handler
 * error still emits (result: failure) and is rethrown unchanged. No-op when the
 * procedure carries no audit tag.
 */
export async function runWithAudit<T>(
  context: AuditContext,
  tag: AuditTag | undefined,
  next: () => T | PromiseLike<T>,
): Promise<T> {
  if (!tag) return next();
  const org = resolveOrg(context);
  try {
    const result = await next();
    await emitAudit(context, tag, org, "success");
    return result;
  } catch (err) {
    await emitAudit(context, tag, org, "failure", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
