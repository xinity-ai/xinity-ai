import { boolean, index, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { userT } from "./auth";


const createdAt = timestamp("created_at").defaultNow().notNull();
const updatedAt = timestamp("updated_at")
  .defaultNow()
  .notNull()
  .$onUpdate(() => new Date());

export const invitationStatusEnum = pgEnum("invitation_status", ["pending", "accepted", "rejected", "cancelled"]);

/**
 * Organization Schema for better-auth organizations plugin.
 *
 * This schema defines the tables required for the organizations plugin.
 */

// Organization table
export const organizationT = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"), // JSON string
  ssoSelfManage: boolean("sso_self_manage").default(false).notNull(),
  createdAt,
  updatedAt,
});

// Member table - links users to organizations
export const memberT = pgTable("member", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => userT.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").notNull().references(() => organizationT.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // e.g., "owner", "admin", "member"
  createdAt,
  updatedAt,
}, table => [
  index("member_user_id_idx").on(table.userId),
  index("member_organization_id_idx").on(table.organizationId),
  uniqueIndex("member_user_id_organization_id_idx").on(table.userId, table.organizationId),
]);

// Invitation table - for inviting users to organizations
export const invitationT = pgTable("invitation", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  inviterId: text("inviter_id").notNull().references(() => userT.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").notNull().references(() => organizationT.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  status: invitationStatusEnum().notNull(),
  createdAt,
  updatedAt,
  expiresAt: timestamp("expires_at").notNull(),
  // Optional: teamId if teams are enabled
  teamId: text("team_id"),
}, table => [
  index("invitation_organization_id_idx").on(table.organizationId),
  index("invitation_email_idx").on(table.email),
]);

export type Organization = typeof organizationT.$inferSelect;
export type Member = typeof memberT.$inferSelect;
export type Invitation = typeof invitationT.$inferSelect;
