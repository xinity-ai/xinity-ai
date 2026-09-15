import { getTableName } from "drizzle-orm";
import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .defaultNow()
  .notNull()
  .$onUpdate(() => new Date());

export const dynamicConfigT = pgTable("dynamic_config", {
  key: text().primaryKey(),
  value: text().notNull(),
  encrypted: boolean().notNull().default(false),
  valueDigest: text("value_digest"),
  updatedBy: text("updated_by"),
  updatedAt,
  createdAt,
});

export const DYNAMIC_CONFIG_CHANNEL = getTableName(dynamicConfigT);
