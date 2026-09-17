import { pgTable, uuid, timestamp, integer, check, text } from "drizzle-orm/pg-core";
import { getTableName, sql } from "drizzle-orm";

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .defaultNow()
  .notNull()
  .$onUpdate(() => new Date());

// Single-row table holding the dashboard's stable per-install identity.
// `singleton` is constrained to 1 so the table can hold at most one row.
export const deploymentConfigT = pgTable("deployment_config", {
  singleton: integer().primaryKey().default(1),
  instanceId: uuid("instance_id").notNull().defaultRandom(),
  createdAt,
}, table => [
  check("deployment_config_singleton_check", sql`${table.singleton} = 1`),
]);

/**
 * Settings an instance admin changes from the dashboard, which running components pick up without
 * a restart. No `encrypted` flag: the envelope names itself, and `enc.` is reserved on write.
 */
export const dynamicConfigT = pgTable("dynamic_config", {
  key: text().primaryKey(),
  value: text().notNull(),
  valueDigest: text("value_digest"),
  updatedBy: text("updated_by"),
  updatedAt,
  createdAt,
});

export const DYNAMIC_CONFIG_CHANNEL = getTableName(dynamicConfigT);
