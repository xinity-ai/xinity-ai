import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizationT } from "./orgSchema";
import { userT } from "./auth";
import type { InferSelectModel } from "drizzle-orm";

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

/** Administrative audit trail: who did what, when (COMPLIANCE.md evidence E11). */
export const auditLogT = pgTable("audit_log", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .references(() => organizationT.id, { onDelete: "cascade" }),
  /** Null for system-initiated events (e.g. retention purge). */
  actorUserId: text("actor_user_id").references(() => userT.id, { onDelete: "set null" }),
  /** Denormalized so the trail survives user deletion. */
  actorEmail: text("actor_email"),
  /** Dot-separated action identifier, e.g. "deployment.create", "member.role-change". */
  action: text().notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  /** Small JSON diff/summary — never raw secrets, never prompt content. */
  details: jsonb().$type<Record<string, unknown>>(),
  traceId: text("trace_id"),
  createdAt,
}, table => [
  index("audit_log_organization_id_created_at_idx").on(table.organizationId, table.createdAt),
  index("audit_log_actor_user_id_idx").on(table.actorUserId),
]);
export type AuditLog = InferSelectModel<typeof auditLogT>;
