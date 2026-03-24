import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { aiApiKeyT } from "./ai-api-key";
import { aiApplicationT } from "./ai-application";
import { organizationT } from "./orgSchema";
import { userT } from "./auth";
import type { InferSelectModel } from "drizzle-orm";
import { callDataSchema } from "./pg-schemas";

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .defaultNow()
  .notNull()
  .$onUpdate(() => new Date());

export type ApiCallInputMessageContent =
  | { type: "text"; text: string }
  /**
   * Image reference stored as an image_url part.
   * When S3 is enabled, `url` is a `xinity-media://{sha256hex}` reference
   * resolved via the mediaObject table. When S3 is disabled, `url` is the
   * original external URL (data URIs are stripped from the log entirely).
   */
  | { type: "image_url"; image_url: { url: string } };
export type ApiCallToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type ApiCallInputMessage = {
  content: string | ApiCallInputMessageContent[] | null;
  role: "assistant" | "user" | "system" | "tool";
  /** Present on assistant messages that invoke tools. */
  tool_calls?: ApiCallToolCall[];
  /** Present on tool result messages (role: "tool"). */
  tool_call_id?: string;
};
export type ApiCall = InferSelectModel<typeof apiCallT>;
export const apiCallT = callDataSchema.table("api_call", {
  id: uuid().primaryKey().defaultRandom(),
  apiKeyId: uuid("api_key_id")
    .references(() => aiApiKeyT.id, { onDelete: "set null" }),
  applicationId: uuid("application_id")
    .references(() => aiApplicationT.id, { onDelete: "set null" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationT.id, { onDelete: "cascade" }),
  model: text().notNull(),
  specifiedModel: text("specified_model").notNull(),
  user: text(),
  /** in milliseconds */
  duration: integer().notNull(),
  inputMessages: jsonb("input_messages").notNull().$type<ApiCallInputMessage[]>(),
  outputMessage: jsonb("output_message").notNull().$type<ApiCallInputMessage>(),
  metadata: jsonb().$type<Record<string, unknown>>(),
  createdAt,
}, table => [
  index("api_call_api_key_id_idx").on(table.apiKeyId),
  index("api_call_application_id_idx").on(table.applicationId),
  index("api_call_organization_id_idx").on(table.organizationId),
  index("api_call_organization_id_created_at_idx").on(table.organizationId, table.createdAt),
  index("api_call_model_idx").on(table.model),
]);

export type Highlight = {
  start: number;
  end: number;
  /** true for positive, false for negative, null for undefined */
  type: boolean;
};
export type InputExclusion = {
  messageIndex: number;
  start: number;
  end: number;
};
export type ApiCallResponse = InferSelectModel<typeof apiCallResponseT>;
/** Table containing responses by users to a logged api call. */
export const apiCallResponseT = callDataSchema.table("api_call_response", {
  /** id of the user creating the response. Can be null if the response comes from an external user */
  userId: text("user_id").notNull().references(() => userT.id, { onDelete: "cascade" }),
  apiCallId: uuid("api_call_id")
    .notNull()
    .references(() => apiCallT.id, { onDelete: "cascade" }),

  /** Represents like (true) dislike (false) or none (null) */
  response: boolean(),
  outputEdit: text("output_edit"),
  highlights: jsonb().$type<Highlight[]>(),
  /** Indices of input messages wholly excluded from training. */
  excludedMessages: jsonb("excluded_messages").$type<number[]>(),
  /** Text-range exclusions within specific input messages. */
  inputExclusions: jsonb("input_exclusions").$type<InputExclusion[]>(),

  createdAt,
  updatedAt,
}, table => [
  primaryKey({ columns: [table.userId, table.apiCallId] }),
]);

/** Per-call usage event. One row for every API call (including unlogged and embeddings). */
export type UsageEvent = InferSelectModel<typeof usageEventT>;
export const usageEventT = callDataSchema.table("usage_event", {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationT.id, { onDelete: "cascade" }),
  applicationId: uuid("application_id")
    .references(() => aiApplicationT.id, { onDelete: "set null" }),
  apiKeyId: uuid("api_key_id")
    .references(() => aiApiKeyT.id, { onDelete: "set null" }),
  model: text().notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  /** Duration in milliseconds. Nullable for endpoints that don't track it. */
  duration: integer(),
  logged: boolean().notNull().default(false),
}, table => [
  index("usage_event_organization_id_created_at_idx").on(table.organizationId, table.createdAt),
  index("usage_event_created_at_idx").on(table.createdAt),
  index("usage_event_api_key_id_idx").on(table.apiKeyId),
]);

/** A media object (image) stored in S3. Referenced from apiCall.inputMessages via xinity-media://{sha256} URLs. */
export type MediaObject = InferSelectModel<typeof mediaObjectT>;
export const mediaObjectT = callDataSchema.table("media_object", {
  id: uuid().primaryKey().defaultRandom(),
  /** Hex-encoded SHA-256 of the raw image bytes. Used as the xinity-media:// URL identifier. */
  sha256: text().notNull(),
  mimeType: text("mime_type").notNull(),
  /** Original source URL if the image came from an external URL. Null for data URIs. */
  originalUrl: text("original_url"),
  s3Bucket: text("s3_bucket").notNull(),
  /** S3 object key, formatted as {organizationId}/{sha256} */
  s3Key: text("s3_key").notNull(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationT.id, { onDelete: "cascade" }),
  /** Size of the image in bytes */
  size: integer().notNull(),
  createdAt,
  updatedAt,
}, table => [
  uniqueIndex("media_object_organization_id_sha256_idx").on(table.organizationId, table.sha256),
  index("media_object_organization_id_idx").on(table.organizationId),
]);

/** Daily usage summary. Produced by rolling up old usageEvent rows. */
export type UsageSummary = InferSelectModel<typeof usageSummaryT>;
/** Nil UUID used as sentinel for "no application" in summary composite key. */
export const NIL_APP_UUID = "00000000-0000-0000-0000-000000000000";

// organizationId, applicationId, and apiKeyId should have foreign key references,
// but they are part of the composite PK (NOT NULL) and the desired onDelete behavior is "set null".
export const usageSummaryT = callDataSchema.table("usage_summary", {
  date: date().notNull(),
  organizationId: text("organization_id").notNull(),
  applicationId: uuid("application_id").notNull().default(NIL_APP_UUID),
  apiKeyId: uuid("api_key_id").notNull(),
  model: text().notNull(),
  totalCalls: integer("total_calls").notNull().default(0),
  loggedCalls: integer("logged_calls").notNull().default(0),
  inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
  outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
  /** Total duration in milliseconds. Nullable for summaries created before this column existed. */
  totalDuration: bigint("total_duration", { mode: "number" }).default(0),
}, table => [
  primaryKey({ columns: [table.date, table.organizationId, table.applicationId, table.apiKeyId, table.model] }),
  index("usage_summary_organization_id_idx").on(table.organizationId),
  index("usage_summary_organization_id_date_idx").on(table.organizationId, table.date),
]);
