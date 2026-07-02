import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { auditEventT, type AuditActorType } from "common-db";

const log = rootLogger.child({ name: "orpc.audit" });

export type AuditTag = { action: string; resource: string };

export type ActorInfo = { actorType: AuditActorType; actorId: string | null };

/** The subset of oRPC context the audit path reads. */
export type AuditContext = {
  request: Request;
  clientAddress?: string;
  actor?: ActorInfo;
  activeOrganizationId?: string;
};

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
  result: "success" | "failure",
  extraContext?: Record<string, unknown>,
): Promise<void> {
  const actor = context.actor ?? { actorType: "system" as const, actorId: null };
  await writeAuditEvent({
    organizationId: context.activeOrganizationId ?? null,
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
  try {
    const result = await next();
    await emitAudit(context, tag, "success");
    return result;
  } catch (err) {
    await emitAudit(context, tag, "failure", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
