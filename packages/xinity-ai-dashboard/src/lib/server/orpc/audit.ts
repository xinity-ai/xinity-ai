import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { auditEventT, type AuditActorType } from "common-db";

const log = rootLogger.child({ name: "orpc.audit" });

/** Every audited action. Naming follows `resource.verb` with a snake_case verb. Add a literal here when tagging a new procedure. */
export type AuditAction =
  | "account.change_password"
  | "account.create_dashboard_api_key"
  | "account.delete_dashboard_api_key"
  | "account.delete_passkey"
  | "aiApplication.create"
  | "aiApplication.delete"
  | "aiApplication.update"
  | "apiKey.create"
  | "apiKey.delete"
  | "apiKey.toggle_collect_data"
  | "apiKey.toggle_enabled"
  | "apiKey.update"
  | "instanceAdmin.add_user_to_org"
  | "instanceAdmin.ban_user"
  | "instanceAdmin.create_user"
  | "instanceAdmin.remove_user_from_org"
  | "instanceAdmin.reset_user_password"
  | "instanceAdmin.set_email_verified"
  | "instanceAdmin.set_sso_self_manage"
  | "instanceAdmin.unban_user"
  | "instanceAdmin.update_user_role"
  | "invitation.cancel"
  | "invitation.create"
  | "member.remove"
  | "member.update_role"
  | "modelDeployment.create"
  | "modelDeployment.delete"
  | "modelDeployment.toggle_enabled"
  | "modelDeployment.update"
  | "onboarding.cli"
  | "onboarding.setup"
  | "organization.create"
  | "organization.delete"
  | "organization.update"
  | "sso.delete_provider"
  | "sso.register_oidc"
  | "sso.register_saml"
  | "user.update_settings";

export type AuditTag = { action: AuditAction; resource: string };

export type ActorInfo = { actorType: AuditActorType; actorId: string | null; actorLabel: string | null };

/** The subset of oRPC context the audit path reads. */
export type AuditContext = {
  request: Request;
  clientAddress?: string;
  actor?: ActorInfo;
  activeOrganizationId?: string;
};

async function writeAuditEvent(row: typeof auditEventT.$inferInsert): Promise<void> {
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
  const actor = context.actor ?? { actorType: "system" as const, actorId: null, actorLabel: null };
  await writeAuditEvent({
    organizationId: context.activeOrganizationId ?? null,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
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
