import { bigint, index, jsonb, pgEnum, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { InferSelectModel } from "drizzle-orm";
import { callDataSchema } from "./pg-schemas";

export const auditActorTypeEnum = pgEnum("audit_actor_type", ["user", "api_key", "system", "instance_admin"]);
export const auditResultEnum = pgEnum("audit_result", ["success", "failure"]);

/** Append-only record of a security-relevant action. */
export const auditEventT = callDataSchema.table("audit_event", {
  id: uuid().primaryKey().defaultRandom(),
  /**
   * Lets a holder of the mirror see that events are missing without trusting anything
   * this instance reports. Should not be renumbered or restarted, retention pruning included.
   */
  streamPosition: bigint("stream_position", { mode: "number" }).generatedAlwaysAsIdentity(),
  /** Denormalized owning organization, carrying no reference, so deleting an organization leaves its trail intact and the organization.delete event can still be written after the row is gone. */
  organizationId: text("organization_id"),
  actorType: auditActorTypeEnum("actor_type").notNull(),
  /** Id of the actor. */
  actorId: text("actor_id"),
  /** Denormalized actor label (email or key name) so the record stays readable after the principal is deleted. */
  actorLabel: text("actor_label"),
  action: text().notNull(),
  resource: text().notNull(),
  /** The specific entity the action targeted, when known. */
  resourceId: text("resource_id"),
  result: auditResultEnum().notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  context: jsonb().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  index("audit_event_organization_id_created_at_idx").on(table.organizationId, table.createdAt),
  index("audit_event_organization_id_actor_id_created_at_idx").on(table.organizationId, table.actorId, table.createdAt),
]);

export type AuditEvent = InferSelectModel<typeof auditEventT>;
export type AuditActorType = (typeof auditActorTypeEnum.enumValues)[number];