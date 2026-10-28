import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { forwardAuditEvent } from "$lib/server/audit/audit-forwarder";
import { auditEventT, type AuditActorType } from "common-db";
import type { AuditAction } from "$lib/audit-actions";

const log = rootLogger.child({ name: "orpc.audit" });

export type AuditTag = {
  action: AuditAction;
  resource: string;
  resourceId?: { fromInput?: string; fromOutput?: string };
  captureInput?: string[];
  captureOutput?: string[];
};

export type ActorInfo = { actorType: AuditActorType; actorId: string | null; actorLabel: string | null };

export type AuditChannel = "rpc" | "api" | "mcp";

/** The subset of oRPC context the audit path reads. */
export type AuditContext = {
  request: Request;
  clientAddress?: string;
  actor?: ActorInfo;
  activeOrganizationId?: string;
  auditChannel?: AuditChannel;
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
  const recordedContext = context.auditChannel
    ? { ...extraContext, channel: context.auditChannel }
    : extraContext;
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
    context: recordedContext,
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
  /** Middleware hands back a wrapper around the handler's return, so what to read has to be said. */
  outputOf: (result: Awaited<T>) => unknown = (result) => result,
): Promise<T> {
  if (!tag) return next();
  try {
    const result = await next();
    const output = outputOf(result);
    const resourceId = resolveResourceId(tag.resourceId, input, output);
    const captured = { ...captureFields(tag.captureInput, input), ...captureFields(tag.captureOutput, output) };
    fireAudit(context, tag, "success", resourceId, Object.keys(captured).length > 0 ? captured : undefined);
    return result;
  } catch (err) {
    const resourceId = resolveResourceId(tag.resourceId, input);
    const captured = captureFields(tag.captureInput, input);
    fireAudit(context, tag, "failure", resourceId, { ...captured, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
