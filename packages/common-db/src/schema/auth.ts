import { boolean, timestamp, pgTable, text, jsonb, integer, index } from "drizzle-orm/pg-core";
import { type InferSelectModel } from "drizzle-orm";
import { organizationT } from "./orgSchema";

const createdAt = timestamp("created_at").defaultNow().notNull();
const updatedAt = timestamp("updated_at")
  .defaultNow()
  .notNull()
  .$onUpdate(() => new Date());

export type NotificationSettings = {
  emailNotifications: boolean;
  modelTrainingAlerts: boolean;
  weeklyReports: boolean;
  apiUsageAlerts: boolean;
};
export type DisplaySettings = {
  darkMode: boolean;
  compactView: boolean;
  showDetailedMetrics: boolean;
  gettingStartedDismissed: boolean;
};
export type User = InferSelectModel<typeof userT>;
export const userT = pgTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull(),
  emailVerified: boolean("email_verified"),
  image: text("image"),
  notificationSettings: jsonb("notification_settings")
    .notNull()
    .$type<NotificationSettings>()
    .$defaultFn(() => ({
      emailNotifications: true,
      modelTrainingAlerts: true,
      weeklyReports: true,
      apiUsageAlerts: true,
    })),
  displaySettings: jsonb("display_settings")
    .notNull()
    .$type<DisplaySettings>()
    .$defaultFn(() => ({
      darkMode: false,
      compactView: false,
      showDetailedMetrics: true,
      gettingStartedDismissed: false,
    })),
  twoFactorEnabled: boolean("two_factor_enabled")
    .notNull()
    .default(false)
    .$default(() => false),

  // Admin fields (unused for the time being)
  role: text().notNull().default("user"),
  banned: boolean().notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires_at"),
  temporaryPassword: boolean("temporary_password").notNull().default(false),
  // Default fields
  createdAt,
  updatedAt,
});

const userId = text("user_id")
  .notNull()
  .references(() => userT.id);

export const accountT = pgTable("account", {
  id: text().primaryKey(),
  userId,
  /** Id for external accounts / sso providers etc */
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text(),
  idToken: text("id_token"),
  password: text(),
  createdAt,
  updatedAt,
}, table => [
  index("account_user_id_idx").on(table.userId),
  index("account_account_id_provider_id_idx").on(table.accountId, table.providerId),
]);

export const sessionT = pgTable("session", {
  id: text().primaryKey(),
  userId: userId,
  token: text().notNull(),
  expiresAt: timestamp("expires_at"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  /** The organization context the user is currently working in */
  activeOrganizationId: text("active_organization_id")
    .references(() => organizationT.id, { onDelete: "set null" }),
  // Admin fields. Unused for the time being
  impersonatedBy: text("impersonated_by"),
  // Default fields
  createdAt,
  updatedAt,
}, table => [
  index("session_user_id_idx").on(table.userId),
  index("session_token_idx").on(table.token),
]);

export const verificationT = pgTable(
  "verification",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt,
    updatedAt,
  },
  (verificationToken) => [
    index("verification_identifier_idx").on(verificationToken.identifier),
  ],
);

export const twoFactorT = pgTable("two_factor", {
  id: text().primaryKey(),
  userId,
  secret: text().notNull(),
  backupCodes: text("backup_codes").notNull(),
}, table => [
  index("two_factor_user_id_idx").on(table.userId),
]);

export const passkeyT = pgTable("passkey", {
  id: text().primaryKey(),
  name: text(),
  publicKey: text("public_key").notNull(),
  userId,
  credentialID: text("credential_id").notNull(),
  counter: integer().notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text().notNull(),
  createdAt,
  updatedAt,
  aaguid: text(),
}, table => [
  index("passkey_user_id_idx").on(table.userId),
])

export const dashboardApiKeyT = pgTable("dashboard_api_key", {
  id: text().primaryKey(),
  configId: text("config_id").notNull().default("default"),
  name: text(),
  start: text(),
  prefix: text(),
  key: text().notNull(),
  userId,
  refillInterval: integer("refill_interval"),
  refillAmount: integer("refill_amount"),
  lastRefillAt: timestamp("last_refill_at"),
  enabled: boolean().notNull().default(true),
  rateLimitEnabled: boolean("rate_limit_enabled").notNull().default(true),
  rateLimitTimeWindow: integer("rate_limit_time_window"),
  rateLimitMax: integer("rate_limit_max"),
  requestCount: integer("request_count"),
  remaining: integer("remaining"),
  lastRequest: timestamp("last_request"),
  expiresAt: timestamp("expires_at"),
  createdAt,
  updatedAt,
  permissions: text("permissions"),
  metadata: jsonb("metadata"),
}, table => [
  index("dashboard_api_key_user_id_idx").on(table.userId),
  index("dashboard_api_key_prefix_idx").on(table.prefix),
  index("dashboard_api_key_config_id_idx").on(table.configId),
])

export const ssoProviderT = pgTable("sso_provider", {
  id: text().primaryKey(),
  issuer: text().notNull(),
  domain: text().notNull(),
  oidcConfig: text("oidc_config"),
  samlConfig: text("saml_config"),
  userId,
  providerId: text("provider_id").notNull(),
  organizationId: text("organization_id").references(() => organizationT.id, { onDelete: "cascade" }),
  domainVerified: boolean("domain_verified").notNull().default(false),
  createdAt,
  updatedAt,
});
