import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { forwardAuditEvent } from "$lib/server/audit-forwarder";
import { auditEventT, type AuditActorType } from "common-db";

const log = rootLogger.child({ name: "orpc.audit" });

/** Every audited action. Naming follows `resource.verb` with a snake_case verb. Add a literal here when tagging a new procedure. */
export type AuditAction =
  | "account.change_password"
  | "account.create_dashboard_api_key"
  | "account.delete_dashboard_api_key"
  | "account.delete_passkey"
  | "account.disable_2fa"
  | "account.enable_2fa"
  | "account.request_password_reset"
  | "account.sign_in"
  | "account.sign_in_sso"
  | "account.sign_out"
  | "account.sign_up"
  | "account.verify_email"
  | "aiApplication.create"
  | "aiApplication.delete"
  | "aiApplication.update"
  | "apiCall.delete"
  | "apiCall.reassign_application"
  | "apiCall.update_metadata"
  | "apiKey.create"
  | "apiKey.delete"
  | "apiKey.toggle_collect_data"
  | "apiKey.toggle_enabled"
  | "apiKey.update"
  | "compute.remove_node"
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
  | "modelDeployment.retry"
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

export type AuditTag = {
  action: AuditAction;
  resource: string;
  resourceId?: { fromInput?: string; fromOutput?: string };
  captureInput?: string[];
  captureOutput?: string[];
};

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
    const [inserted] = await getDB().insert(auditEventT).values(row).returning();
    if (inserted) {
      forwardAuditEvent(inserted);
    }
  } catch (err) {
    log.warn({ err, action: row.action, resource: row.resource }, "Failed to write audit event");
  }
}

/**
 * Records an audit event for a Better Auth flow (e.g. 2FA) that bypasses oRPC.
 * Fire-and-forget, personal scope (null org), always a user actor.
 */
export function emitAuthAuditEvent(params: {
  action: AuditAction;
  resource: string;
  actorId: string | null;
  actorLabel: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  resourceId?: string | null;
  result?: "success" | "failure";
}): void {
  void writeAuditEvent({
    organizationId: null,
    actorType: "user",
    actorId: params.actorId,
    actorLabel: params.actorLabel,
    action: params.action,
    resource: params.resource,
    resourceId: params.resourceId ?? null,
    result: params.result ?? "success",
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    context: null,
  }).catch((err) => log.warn({ err, action: params.action }, "Failed to emit auth audit event"));
}

function captureFields(keys: string[] | undefined, source: unknown): Record<string, unknown> | undefined {
  if (!keys || !source || typeof source !== "object") return undefined;
  const obj = source as Record<string, unknown>;
  const captured: Record<string, unknown> = {};
  let hasAny = false;
  for (const key of keys) {
    if (key in obj && obj[key] !== undefined) {
      captured[key] = obj[key];
      hasAny = true;
    }
  }
  return hasAny ? captured : undefined;
}

function resolveResourceId(
  config: AuditTag["resourceId"],
  input: unknown,
  output?: unknown,
): string | null {
  if (!config) return null;
  if (config.fromInput && input && typeof input === "object") {
    const val = (input as Record<string, unknown>)[config.fromInput];
    if (typeof val === "string") return val;
  }
  if (config.fromOutput && output && typeof output === "object") {
    const val = (output as Record<string, unknown>)[config.fromOutput];
    if (typeof val === "string") return val;
  }
  return null;
}

async function emitAudit(
  context: AuditContext,
  tag: AuditTag,
  result: "success" | "failure",
  resourceId: string | null,
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
    resourceId,
    result,
    ipAddress: context.clientAddress || null,
    userAgent: context.request.headers.get("user-agent"),
    context: extraContext,
  });
}

function fireAudit(context: AuditContext, tag: AuditTag, result: "success" | "failure", resourceId: string | null, extraContext?: Record<string, unknown>): void {
  void emitAudit(context, tag, result, resourceId, extraContext).catch((err) => log.warn({ err }, "Failed to emit audit event"));
}

/**
 * Runs `next`, then emits one audit event reflecting the outcome (fire-and-forget,
 * so the write never blocks or breaks the request). A handler error still emits
 * (result: failure) and is rethrown. No-op when the procedure carries no audit tag.
 */
export async function runWithAudit<T>(
  context: AuditContext,
  tag: AuditTag | undefined,
  input: unknown,
  next: () => T | PromiseLike<T>,
): Promise<T> {
  if (!tag) return next();
  try {
    const result = await next();
    const resourceId = resolveResourceId(tag.resourceId, input, result);
    const captured = { ...captureFields(tag.captureInput, input), ...captureFields(tag.captureOutput, result) };
    fireAudit(context, tag, "success", resourceId, Object.keys(captured).length > 0 ? captured : undefined);
    return result;
  } catch (err) {
    const resourceId = resolveResourceId(tag.resourceId, input);
    const captured = captureFields(tag.captureInput, input);
    fireAudit(context, tag, "failure", resourceId, { ...captured, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
