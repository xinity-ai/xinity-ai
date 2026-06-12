# Design: Compliance Features (COMPLIANCE.md §6.1–6.4)

**Status:** Draft — implementation guide
**Scope:** The four core compliance features from [COMPLIANCE.md](COMPLIANCE.md) §6: retention engine, administrative audit log, compliance posture dashboard, and audit evidence pack generator. DSAR tooling (§6.5) and Art. 50 readiness (§6.6) are explicitly out of scope.
**Audience:** Implementers (including Claude Code). Read [COMPLIANCE.md](COMPLIANCE.md) §4–§5 first — the evidence artifact IDs (E1–E12) used below are defined there.

---

## 0. Ground rules and shared conventions

Everything below builds on existing patterns. Do not invent new infrastructure.

- **Workspace:** Bun monorepo. Database schema lives in `packages/common-db/src/schema/` (Drizzle ORM, PostgreSQL). After editing schema, generate migrations with `bun run migrate:gen` in `packages/common-db/` (output lands in `db-migration/`).
- **Dashboard:** SvelteKit 2 + Svelte 5 in `packages/xinity-ai-dashboard`. Its `CLAUDE.md` documents the house patterns; follow it. Type-check with `bun run check`.
- **oRPC procedures:** New procedures go in `packages/xinity-ai-dashboard/src/lib/server/orpc/procedures/`. Every procedure chains `withOrganization` (or `withAuth`) and `requirePermission({resource: [actions]})` from `../root` — the `add-dashboard-orpc-procedure` skill describes the mandatory guard review; apply it to every new procedure file.
- **Logging:** `rootLogger.child({ name: "<module>" })`, with `log.child({ traceId: context.traceId })` inside handlers (see `api-call.procedure.ts`).
- **Background jobs:** Follow `src/lib/server/notifications/scheduler.ts` — interval loops started once from `src/hooks.server.ts` (see `startNotificationScheduler`), guarded against running during `building`.
- **License gating:** `hasFeature(feature)` from `$lib/server/license`. The `"audit-log"` feature already exists in `LicenseFeature` (`src/lib/server/license/types.ts`).
- **Env vars:** Only if genuinely needed; use the `add-env-variable` skill (Zod schema in `serverenv.ts`). This design intentionally keeps configuration in the database (per-org), not env.
- **Verification:** Run the `run-tests` skill after each phase; `bun run check` in the dashboard package after UI work.

### 0.1 New RBAC resources (do once, first)

Add two resources in `packages/xinity-ai-dashboard/src/lib/roles.ts`:

```ts
const customResourcePermissions = {
  // ...existing...
  compliance: ["read", "update"],
  auditLog: ["read"],
} as const;
```

**Do not** let these flow through the `fullAccessPermissions` spread — that grants full access to `member`, and compliance settings (retention periods!) must be restricted. Assign explicitly:

| Role | compliance | auditLog |
|---|---|---|
| owner | read, update | read |
| admin | read, update | read |
| member | read | — |
| labeler | — | — |
| viewer | — | — |

Practically: remove `compliance`/`auditLog` from the object spread into `member` (build the role statements so the new resources are only added to `owner` and `admin`, plus `compliance: ["read"]` for `member`).

### 0.2 Licensing boundary — ELv2 premium feature

The repository is dual-licensed: gateway, daemon, CLI, infoserver, and `common-db` are Apache 2.0; the **dashboard is Elastic License v2** with paid tiers unlocking `LicenseFeature` flags. The compliance features are a dashboard/ELv2 premium feature:

- **All compliance logic lives in `packages/xinity-ai-dashboard`** (ELv2): the retention scheduler, `recordAudit`, the check engine, artifact routes, and the audit pack assembly/rendering. No compliance logic goes into Apache-licensed packages.
- `common-db` carries **only the table definitions** — this matches the existing precedent (the `ssoProvider` table is Apache-licensed schema while SSO logic is ELv2-gated in the dashboard).
- Add one new value to `LicenseFeature` in `src/lib/server/license/types.ts`: `"compliance-reports"`.

Gating matrix:

| Capability | License gate |
|---|---|
| Audit log **recording** | Always on (no holes in the trail — see Phase 2.2) |
| Audit log **read/UI** | `audit-log` (existing feature flag) |
| Posture dashboard, artifact storage, check engine | `compliance-reports` |
| Audit pack generation | `compliance-reports` |
| Retention engine (policy + purge) | **Free tier — deliberately not gated.** Charging customers to be able to delete personal data is GDPR-hostile and would undercut the entire compliance story; the purge capability is also the fix for the platform's own Art. 5(1)(e) liability (COMPLIANCE.md §5.2(1)) |

Server-side: guard gated procedures/routes with `hasFeature(...)` → `FORBIDDEN` with a clear upgrade message. Client-side: surface gating the same way existing premium features do (see `LicenseBanner.svelte` and how `sso` gating reaches the client via the license summary).

### 0.3 New schema files

Two new files in `packages/common-db/src/schema/`, exported from the package index like the existing ones. Use the existing `createdAt`/`updatedAt` column helpers pattern from `call-data.ts`. Tables live in the default (public) schema — they are organizational/administrative data, not call data, so do **not** put them in `callDataSchema`.

---

## Phase 1 — Retention engine (prerequisite for everything else)

**Why first:** see COMPLIANCE.md §5.2(1). Until this lands, `apiCall` rows (full prompts/completions) are retained indefinitely, which conflicts with GDPR Art. 5(1)(e). The audit pack (Phase 4) must be able to show both a configured policy and proof of enforcement (evidence E4).

### 1.1 Schema — `compliance.ts`

```ts
/** Per-organization data retention policy. One row per org; absence = retention not configured. */
export const retentionPolicyT = pgTable("retention_policy", {
  organizationId: text("organization_id").primaryKey()
    .references(() => organizationT.id, { onDelete: "cascade" }),
  /** Days to keep apiCall rows (and their apiCallResponse rows via cascade). Null = keep forever (explicit choice). */
  apiCallRetentionDays: integer("api_call_retention_days"),
  /** Days to keep mediaObject rows + S3 blobs. Null = follow apiCallRetentionDays. */
  mediaRetentionDays: integer("media_retention_days"),
  updatedByUserId: text("updated_by_user_id").references(() => userT.id, { onDelete: "set null" }),
  createdAt, updatedAt,
});

/** Record of each purge run — the enforcement evidence for the audit pack (E4). */
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
```

Design decisions:
- **Null means "keep forever" as an explicit, recorded choice** — the posture dashboard (Phase 3) shows this as a red/amber check, but the platform never silently picks a default retention for a controller's data.
- An *absent row* means "never configured", which is a distinct (worse) posture state than an explicit policy.
- `retentionRun` rows are themselves subject to no purge — they are tiny and are the compliance evidence.

### 1.2 Purge scheduler — `src/lib/server/compliance/retention.service.ts`

Mirror `notifications/scheduler.ts`:

- Started from `hooks.server.ts` next to `startNotificationScheduler()`, skipped when `building`.
- Interval: hourly check; execute a purge per org at most once per 24h (track last run via the newest `retentionRun` row, not in-memory state, so restarts don't double- or never-run).
- Per org with a configured policy:
  1. Compute cutoffs (`now - retentionDays`).
  2. Delete `apiCall` where `organizationId = org AND createdAt < cutoff` in **batches** (e.g. `LIMIT 5000` loop using a subquery on `id`) — these tables can be large; never one giant `DELETE`. `apiCallResponse` cascades.
  3. For media: select `mediaObject` rows past cutoff, delete the S3 objects via the existing image-store module (`src/lib/server/image-store.ts`), then delete the rows. If S3 deletion fails, keep the row and record the error — never leave orphaned blobs.
  4. Insert one `retentionRun` row with counts, cutoffs, and any error.
- **Do not** touch `usageEvent`/`usageSummary` — aggregated token counts contain no personal data content and are needed for billing/capacity; document this in the report as the per-category differentiation Art. 5(1)(e) expects (raw content: short retention; aggregates: longer).

### 1.3 Procedure + UI

- `compliance.procedure.ts` (new): `getRetentionPolicy` (`compliance: ["read"]`), `setRetentionPolicy` (`compliance: ["update"]`), `listRetentionRuns` (`compliance: ["read"]`). Router prefix `/compliance`.
- UI: new route `(authenticated)/compliance/` — for Phase 1 just a retention card (configure days, see last runs). This page grows into the posture dashboard in Phase 3, so name routes/components accordingly from the start.

**Acceptance:** configuring a 30-day policy and inserting a backdated `apiCall` row (dev-only seeding exists in `api-call.procedure.ts`) results in the row being purged on the next cycle and a `retentionRun` row recording it.

---

## Phase 2 — Administrative audit log

**Why:** evidence E11 plus "who did what, when" (COMPLIANCE.md §5.2(2), §6.2). Activates the existing `"audit-log"` license feature.

### 2.1 Schema — `audit-log.ts`

```ts
export const auditLogT = pgTable("audit_log", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .references(() => organizationT.id, { onDelete: "cascade" }),
  /** Null for system-initiated events (e.g. retention purge). */
  actorUserId: text("actor_user_id").references(() => userT.id, { onDelete: "set null" }),
  /** Denormalized so the trail survives user deletion. */
  actorEmail: text("actor_email"),
  action: text().notNull(),       // e.g. "deployment.create", "member.role-change"
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  /** Small JSON diff/summary — never raw secrets, never prompt content. */
  details: jsonb().$type<Record<string, unknown>>(),
  traceId: text("trace_id"),
  createdAt,
}, table => [
  index("audit_log_organization_id_created_at_idx").on(table.organizationId, table.createdAt),
  index("audit_log_actor_user_id_idx").on(table.actorUserId),
]);
```

### 2.2 Recording — explicit helper, not magic middleware

Add `src/lib/server/audit.ts`:

```ts
export async function recordAudit(ctx, entry: { action: string; resourceType: string; resourceId?: string; details?: Record<string, unknown> }): Promise<void>
```

- Fills actor/org/traceId from the oRPC context shape (`session`, `activeOrganizationId`, `traceId`).
- **Never throws** — log a warning on failure; an audit-write failure must not fail the business operation.
- **Always records**, regardless of license. Only *reading* the log is license-gated (otherwise the trail has holes from before an upgrade).

Explicit calls beat a blanket middleware here: only mutations are audit-relevant, the `details` payload is action-specific, and an auto-middleware would either log reads (noise) or need per-procedure annotations anyway. Add `recordAudit` calls to every mutating handler in:

- `deployment.procedure.ts` (create/update/delete/enable)
- `api-key.procedure.ts` (create/update/delete — record key *name and prefix*, never the key)
- `application.procedure.ts`, `model.procedure.ts`, `sso.procedure.ts`, `organization.procedure.ts`, `instance-admin.procedure.ts`
- `compliance.procedure.ts` from Phase 1 (`retention-policy.update` is itself an auditable act)
- the existing data export route `(authenticated)/data/export/[callId]/+server.ts` (action `apiCall.export` — auditors specifically ask who exported inference data)

Member/role/invitation changes go through Better Auth, not our procedures — hook them via Better Auth's `databaseHooks` in `auth-server.ts` (member create/update/delete), which is the same mechanism the codebase already uses for auth customization. Retention purge runs (Phase 1) also write an `auditLog` entry (system actor) in addition to `retentionRun`.

### 2.3 Read API + UI

- `listAuditLog` in `compliance.procedure.ts`: `requirePermission({ auditLog: ["read"] })`, filters (date range, action, actor), keyset pagination on `(createdAt, id)`. Guard with `hasFeature("audit-log")` → `FORBIDDEN` with a clear message when unlicensed.
- UI: table on the compliance page (filterable, like the existing API-call tables), behind the same feature flag (license summary is already exposed to the client — follow how `sso` gating is surfaced).

**Acceptance:** creating + deleting a deployment via the dashboard produces two `auditLog` rows with correct actor, org, and details; a viewer-role user cannot read the log; export route writes an audit row.

---

## Phase 3 — Compliance posture dashboard

**Why:** the customer's actual question is "are we in good shape?" — answered by an exhaustive checklist, half automated, half tracked (COMPLIANCE.md §6.3).

### 3.1 Check engine — `src/lib/server/compliance/checks.ts`

A static array of check definitions, each:

```ts
type ComplianceCheck = {
  id: string;                    // "retention-configured"
  kind: "automated" | "organizational";
  evidenceIds: string[];         // ["E4"] — links into COMPLIANCE.md §4
  articleRef: string;            // "Art. 5(1)(e) GDPR"
  title: string;
  explanation: string;           // plain-language, one paragraph
  run?: (orgId: string) => Promise<CheckResult>;  // automated only
};
type CheckResult = { status: "pass" | "warn" | "fail"; detail: string };
```

Automated checks (all computable from existing tables — keep each `run` a single focused query):

| id | logic | evidence |
|---|---|---|
| `retention-configured` | `retentionPolicy` row exists and days non-null → pass; row with nulls → warn; no row → fail | E4 |
| `retention-enforced` | newest successful `retentionRun` < 48h old (only when policy set) | E4 |
| `audit-log-active` | license has `audit-log` and ≥1 row in last 30 days | E11 |
| `models-from-catalog` | every enabled `modelDeployment.specifier` resolves in the infoserver catalog (use `info-client.ts`) with an upstream source link | E10, E12 |
| `mfa-or-sso` | every org member has `twoFactorEnabled`, a passkey, or org has a verified `ssoProvider` | E3, E11 |
| `logging-consent-reviewed` | every enabled `aiApiKey` has `collectData` explicitly set; warn listing keys that log data | E1 |
| `no-stale-admin-keys` | no enabled `dashboardApiKey`/`aiApiKey` without expiry older than 1 year → warn | E3 |

Organizational checks are the uploadable artifacts: DPIA (E2), usage policy (E8), training records (E9), model due-diligence (E7), breach procedure (E5), DSR procedure (E6). Their status comes from Phase 3.2.

### 3.2 Organizational artifact tracking — schema addition in `compliance.ts`

```ts
export const complianceArtifactT = pgTable("compliance_artifact", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull()
    .references(() => organizationT.id, { onDelete: "cascade" }),
  /** Matches an organizational check id, e.g. "dpia". One current artifact per (org, kind). */
  kind: text().notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  /** Stored inline; capped at 20 MB. Avoids a hard dependency on the optional S3 store. */
  data: customType-bytea, // use drizzle customType for bytea; see note below
  size: integer().notNull(),
  note: text(),
  /** Self-declared review-by date; posture turns amber when passed. */
  reviewBy: date("review_by"),
  uploadedByUserId: text("uploaded_by_user_id").references(() => userT.id, { onDelete: "set null" }),
  createdAt, updatedAt,
}, table => [
  uniqueIndex("compliance_artifact_org_kind_idx").on(table.organizationId, table.kind),
]);
```

Notes:
- Drizzle has no built-in `bytea`; define a `customType` (there is no existing one in `common-db` — add it in this schema file).
- Inline Postgres storage is deliberate: artifacts are a handful of PDFs per org, and SeaweedFS is optional per deployment. Enforce the 20 MB cap server-side.
- Upload/download cannot go through JSON oRPC: add SvelteKit routes `(authenticated)/compliance/artifact/+server.ts` (POST multipart) and `.../artifact/[artifactId]/+server.ts` (GET, `Content-Disposition: attachment`), modeled on `data/export/[callId]/+server.ts`, with the same `compliance` permission checks done manually (these routes bypass oRPC middleware — replicate the session + `hasPermission` check; see how the export route authenticates). Both write `recordAudit` entries.
- `reviewBy` matters: the EDPB questionnaire explicitly asks for DPIA *review deadlines* (E2), so the dashboard should nag when a review date passes.

### 3.3 Procedure + UI

- All Phase 3 procedures and artifact routes are gated by `hasFeature("compliance-reports")` in addition to RBAC (§0.2).
- `getPostureReport` in `compliance.procedure.ts` (`compliance: ["read"]`): runs all automated checks, merges artifact status, returns the full check list with statuses. Cache per org for ~5 minutes in-memory (checks hit several tables).
- UI on `(authenticated)/compliance/`: summary header ("12 of 14 checks evidence-complete"), two sections (Automated / Organizational), each check expandable to its explanation + article ref, upload slots on organizational items. shadcn-svelte components, permission-gated controls via `permissions.svelte.ts`.
- **Wording rule (load-bearing):** the aggregate state is "evidence complete" / "gaps found" — never the word "compliant". See COMPLIANCE.md §6.3.

**Acceptance:** fresh org shows mostly red/amber; configuring retention + uploading a DPIA flips the respective checks; statuses match underlying data after manual changes.

---

## Phase 4 — Audit Evidence Pack generator

**Why:** the "button" (COMPLIANCE.md §6.4). One action produces a reviewable document plus machine-readable evidence for a chosen date range.

### 4.1 Output format decision

**Generate a self-contained, print-optimized HTML document plus a ZIP of machine-readable JSON — not server-side PDF.** Rationale: the dashboard compiles to a single Bun binary; headless-Chromium PDF rendering is unacceptable in that constraint, and pure-JS PDF libs (pdfkit etc.) mean reimplementing all layout twice. A print-CSS HTML file (`@page` rules, page breaks per section, embedded styles, no external assets) prints to PDF in any browser and is itself archivable. Auditors receive: `audit-pack-<org>-<range>.zip` containing `report.html` + `evidence/*.json` + the uploaded organizational artifacts (E2, E5–E9 files). If a true server-side PDF is later demanded, it slots in behind the same data assembly without redesign.

### 4.2 Data assembly — `src/lib/server/compliance/audit-pack.ts`

One function `assembleAuditPack(orgId, from, to)` returning a typed structure; every section maps to queries on existing tables. Sections (numbering mirrors COMPLIANCE.md §6.4):

1. **Cover & controller position** — org name, instance id (`deploymentConfig`), generation timestamp, date range, Xinity version, the static §2 text from COMPLIANCE.md (controller position, DSK closed-system citation), and the posture summary from Phase 3.
2. **AI system register (E10)** — all `modelDeployment` rows (incl. soft-deleted within range) joined with catalog metadata from `info-client.ts`: model name, specifier, upstream source URL, capability tags, driver; deployment lifecycle history from `modelInstallationState`; serving nodes from `aiNode` (GPU/driver inventory).
3. **ROPA technical annex (E1)** — generated description of processing: data categories stored (enumerate from schema: prompts/completions, feedback, usage aggregates, media), purposes (from `aiApplication` names/descriptions), recipients (none — on-prem; cite Security Whitepaper §3.1), storage location (customer Postgres/S3), retention per category (Phase 1 policy), plus per-application API-key inventory with `collectData` flags.
4. **TOMs annex (E3)** — generated from platform state: auth mechanisms in use (counts of 2FA/passkey/SSO members), the RBAC role/permission matrix (render from `roles.ts` statements), API-key hashing (bcrypt), org-scoped tenancy, audit-log status, TLS/air-gap notes (static text + instance config where known).
5. **Retention policy & enforcement (E4)** — Phase 1 policy + `retentionRun` history in range.
6. **Access & audit report (E11)** — member list with roles, session statistics (count, distinct IPs — not the raw IP list by default), audit-log extract for the range (Phase 2).
7. **Deployer / GPAI classification (E12)** — generated statement: models deployed, sourced unmodified from catalog with upstream links, therefore deployer position per the Commission GPAI guidelines (static reasoning text + live model table).
8. **Art. 50 readiness** — static checklist text with the org's application inventory.
9. **Organizational artifacts** — Phase 3 uploads embedded in the ZIP and indexed in the HTML; **missing artifacts rendered as an explicit "Open gaps" section**, never omitted.

Every section carries its article references and a footer with generation timestamp + a `legalMappingVersion` constant (bump when COMPLIANCE.md's legal mapping changes — see its §3 caveat on the Digital Omnibus).

### 4.3 Rendering + endpoint

- Template: a Svelte component rendered server-side to static HTML (the codebase already server-renders Svelte → MJML for emails in `src/lib/components/mailTemplates/`; reuse that render approach with a print stylesheet instead of MJML).
- ZIP: Bun has no stdlib zip; add the small `fflate` dependency (pure JS, works in compiled binaries).
- Endpoint: `generateAuditPack` — because the response is a binary download, implement as `(authenticated)/compliance/audit-pack/+server.ts` (GET with `from`/`to` query params) with manual session + `requirePermission`-equivalent check (`compliance: ["read"]`) plus `hasFeature("compliance-reports")` (§0.2), like the artifact routes. Writes a `recordAudit` entry (`compliance.audit-pack.generate`).
- UI: "Generate Audit Pack" button + date-range picker on the compliance page, with a visible note that the pack is evidence, not a certification.

**Acceptance:** generated pack for a seeded org opens standalone in a browser, prints cleanly to PDF with one section per page-group, lists a missing DPIA under "Open gaps", and the ZIP's JSON files round-trip parse.

---

## Build order & dependency summary

```
0. roles.ts resources + schema files scaffold + migration
1. Retention engine        (schema → service → procedure → UI card)
2. Audit log               (schema → recordAudit + call sites → read API → UI table)
3. Posture dashboard       (checks engine → artifact storage/routes → posture UI)
4. Audit pack              (assembly → HTML template → zip endpoint → button)
```

Each phase is independently shippable and reviewable; 2 depends on 0 only, 3 depends on 1–2 (checks read their tables), 4 depends on 1–3.

## Cross-cutting cautions

- **Never put prompt/completion content** into `auditLog.details`, check results, or the audit pack (the pack documents *that* and *how* inference data is processed, not the data itself).
- **Secrets:** audit entries for API keys record name + prefix only; SSO audit entries must redact `oidcConfig`/`samlConfig` values.
- Soft-deleted rows (`deletedAt`) must remain visible to the register/audit sections for their date range — filter on range, not on `isNull(deletedAt)`, where history is the point.
- All new procedures: review against the `add-dashboard-orpc-procedure` skill checklist (permission guard present, correct resource, `withOrganization` before `requirePermission`).
- Migration discipline: one migration per phase, generated via `bun run migrate:gen`, never hand-edited.
