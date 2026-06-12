import {
  customType,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizationT } from "./orgSchema";
import { userT } from "./auth";
import type { InferSelectModel } from "drizzle-orm";

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .defaultNow()
  .notNull()
  .$onUpdate(() => new Date());

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/** Per-organization data retention policy. One row per org; absence = retention not configured. */
export const retentionPolicyT = pgTable("retention_policy", {
  organizationId: text("organization_id").primaryKey()
    .references(() => organizationT.id, { onDelete: "cascade" }),
  /** Days to keep apiCall rows (and their apiCallResponse rows via cascade). Null = keep forever (explicit choice). */
  apiCallRetentionDays: integer("api_call_retention_days"),
  /** Days to keep mediaObject rows + S3 blobs. Null = follow apiCallRetentionDays. */
  mediaRetentionDays: integer("media_retention_days"),
  updatedByUserId: text("updated_by_user_id").references(() => userT.id, { onDelete: "set null" }),
  createdAt,
  updatedAt,
});
export type RetentionPolicy = InferSelectModel<typeof retentionPolicyT>;

/** Record of each purge run — the enforcement evidence for the audit pack (COMPLIANCE.md evidence E4). */
export const retentionRunT = pgTable("retention_run", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull()
    .references(() => organizationT.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  deletedApiCalls: integer("deleted_api_calls").notNull().default(0),
  deletedMediaObjects: integer("deleted_media_objects").notNull().default(0),
  /** Cutoff timestamps applied, for the report. */
  apiCallCutoff: timestamp("api_call_cutoff", { withTimezone: true }),
  mediaCutoff: timestamp("media_cutoff", { withTimezone: true }),
  error: text(),
}, table => [
  index("retention_run_organization_id_started_at_idx").on(table.organizationId, table.startedAt),
]);
export type RetentionRun = InferSelectModel<typeof retentionRunT>;

/** Uploaded organizational compliance artifact (DPIA, usage policy, ...). One current artifact per (org, kind). */
export const complianceArtifactT = pgTable("compliance_artifact", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull()
    .references(() => organizationT.id, { onDelete: "cascade" }),
  /** Matches an organizational check id, e.g. "dpia". */
  kind: text().notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  /** Stored inline; capped at 20 MB server-side. Avoids a hard dependency on the optional S3 store. */
  data: bytea().notNull(),
  size: integer().notNull(),
  note: text(),
  /** Self-declared review-by date; posture turns amber when passed. */
  reviewBy: date("review_by"),
  uploadedByUserId: text("uploaded_by_user_id").references(() => userT.id, { onDelete: "set null" }),
  createdAt,
  updatedAt,
}, table => [
  uniqueIndex("compliance_artifact_org_kind_idx").on(table.organizationId, table.kind),
]);
export type ComplianceArtifact = InferSelectModel<typeof complianceArtifactT>;
