import { auditLogT } from "common-db";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "audit" });

type AuditContext = {
  traceId?: string;
  session?: { user: { id: string; email: string } };
  activeOrganizationId?: string;
};

export type AuditEntry = {
  /** Dot-separated action identifier, e.g. "deployment.create". */
  action: string;
  resourceType: string;
  resourceId?: string;
  /** Small JSON summary — never secrets, never prompt content. */
  details?: Record<string, unknown>;
  /**
   * Override for events outside an active-organization context. Pass null
   * explicitly for events that must survive the org's FK cascade (e.g. the
   * organization.delete entry itself).
   */
  organizationId?: string | null;
  /** Override for events where the actor is not on the oRPC context (e.g. auth hooks). */
  actor?: { id: string; email: string } | null;
};

/**
 * Records an administrative audit event. Never throws: an audit-write
 * failure must not fail the business operation it documents. Recording is
 * not license-gated (only reading is), so the trail has no gaps from
 * periods before a license upgrade.
 */
export async function recordAudit(context: AuditContext, entry: AuditEntry): Promise<void> {
  const actor = entry.actor !== undefined ? entry.actor : context.session?.user ?? null;
  try {
    await getDB().insert(auditLogT).values({
      organizationId: entry.organizationId !== undefined
        ? entry.organizationId
        : context.activeOrganizationId ?? null,
      actorUserId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      details: entry.details,
      traceId: context.traceId ?? null,
    });
  } catch (err) {
    log.warn({ err, action: entry.action }, "Failed to record audit entry");
  }
}
