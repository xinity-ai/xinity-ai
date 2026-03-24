import { sql, type InferSelectModel } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationT } from "./orgSchema";

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .defaultNow()
  .notNull()
  .$onUpdate(() => new Date());
const deletedAt = timestamp("deleted_at", { withTimezone: true });

export const aiApplicationT = pgTable("ai_application", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  description: text(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationT.id, { onDelete: "restrict" }),
  deletedAt,
  createdAt,
  updatedAt,
}, table => [
  index("ai_application_organization_id_idx").on(table.organizationId),
  index("ai_application_deleted_at_idx").on(table.deletedAt),
  uniqueIndex("ai_application_name_organization_id_unique")
    .on(table.name, table.organizationId)
    .where(sql`${table.deletedAt} IS NULL`),
]);

export type AIApplicationT = InferSelectModel<typeof aiApplicationT>;
