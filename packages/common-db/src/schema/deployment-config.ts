import { pgTable, uuid, timestamp, integer, check } from "drizzle-orm/pg-core";
import { sql, type InferSelectModel } from "drizzle-orm";

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

// Single-row table holding the dashboard's stable per-install identity.
// `singleton` is constrained to 1 so the table can hold at most one row.
export const deploymentConfigT = pgTable("deployment_config", {
  singleton: integer().primaryKey().default(1),
  instanceId: uuid("instance_id").notNull().defaultRandom(),
  createdAt,
}, table => [
  check("deployment_config_singleton_check", sql`${table.singleton} = 1`),
]);

export type DeploymentConfig = InferSelectModel<typeof deploymentConfigT>;
