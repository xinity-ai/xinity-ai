import { pgTable, text, timestamp, uuid, jsonb, index } from "drizzle-orm/pg-core";
import type { InferSelectModel } from "drizzle-orm";
import { userT } from "./auth";
import { organizationT } from "./orgSchema";

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const deletedAt = timestamp("deleted_at", { withTimezone: true });

export const notificationT = pgTable("notification", {
  id: uuid().primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => userT.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").references(() => organizationT.id, { onDelete: "cascade" }),
  type: text().notNull(),
  channel: text().notNull().default("email"),
  subject: text().notNull(),
  metadata: jsonb().$type<Record<string, unknown>>(),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt,
  createdAt,
}, table => [
  index("notification_user_id_idx").on(table.userId),
  index("notification_organization_id_idx").on(table.organizationId),
  index("notification_type_idx").on(table.type),
  index("notification_deleted_at_idx").on(table.deletedAt),
]);

export type Notification = InferSelectModel<typeof notificationT>;
