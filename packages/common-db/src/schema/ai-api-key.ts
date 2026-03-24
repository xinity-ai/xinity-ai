import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationT } from "./orgSchema";
import { aiApplicationT } from "./ai-application";
import { userT } from "./auth";
import type { InferSelectModel } from "drizzle-orm";

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .defaultNow()
  .notNull()
  .$onUpdate(() => new Date());
const deletedAt = timestamp("deleted_at", { withTimezone: true });

export const aiApiKeyT = pgTable("ai_api_key", {
  id: uuid().primaryKey().defaultRandom(),
  specifier: text().notNull(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationT.id, { onDelete: "cascade" }),
  applicationId: uuid("application_id")
    .references(() => aiApplicationT.id, { onDelete: "set null" }),
  enabled: boolean().notNull().default(true),
  collectData: boolean("collect_data").notNull().default(true),
  createdByUserId: text("created_by_user_id")
    .references(() => userT.id, { onDelete: "set null" }),
  name: text().notNull(),
  hash: text().notNull(),
  deletedAt,
  createdAt,
  updatedAt,
}, table => [
  index("ai_api_key_organization_id_idx").on(table.organizationId),
  uniqueIndex("ai_api_key_specifier_idx").on(table.specifier),
  index("ai_api_key_application_id_idx").on(table.applicationId),
  index("ai_api_key_deleted_at_idx").on(table.deletedAt),
]);
export type AIAPIKeyT = InferSelectModel<typeof aiApiKeyT>;
