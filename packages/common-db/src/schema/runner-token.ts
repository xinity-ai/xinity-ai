import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationT } from "./orgSchema";
import { userT } from "./auth";
import type { InferSelectModel } from "drizzle-orm";

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .defaultNow()
  .notNull()
  .$onUpdate(() => new Date());
const deletedAt = timestamp("deleted_at", { withTimezone: true });

/**
 * Long-lived credential a runner presents to the conductor on every connection.
 * Created via the dashboard, distributed out-of-band to runner hosts.
 * The plaintext secret is shown to the operator exactly once at creation time;
 * only the argon2id hash is stored in this row.
 */
export const runnerTokenT = pgTable("runner_token", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationT.id, { onDelete: "cascade" }),
  name: text().notNull(),
  /** Public token prefix used as the lookup key. Acts as the row identifier embedded in the secret. */
  prefix: text().notNull(),
  /** Argon2id hash of the full plaintext secret. Verified after the row is found via {@link prefix}. */
  hashedSecret: text("hashed_secret").notNull(),
  /** First few characters of the secret, shown in lists so an operator can identify which token is which. */
  secretPreview: text("secret_preview").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdByUserId: text("created_by_user_id")
    .references(() => userT.id, { onDelete: "set null" }),

  deletedAt,
  createdAt,
  updatedAt,
}, table => [
  index("runner_token_organization_id_idx").on(table.organizationId),
  uniqueIndex("runner_token_org_name_idx")
    .on(table.organizationId, table.name)
    .where(sql`${table.deletedAt} IS NULL`),
  uniqueIndex("runner_token_prefix_idx").on(table.prefix),
  index("runner_token_deleted_at_idx").on(table.deletedAt),
]);
export type RunnerToken = InferSelectModel<typeof runnerTokenT>;
