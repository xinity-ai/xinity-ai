import {
  aiApiKeyT,
  and,
  auditLogT,
  complianceArtifactT,
  count,
  eq,
  gte,
  isNull,
  lt,
  memberT,
  modelDeploymentT,
  passkeyT,
  retentionPolicyT,
  retentionRunT,
  ssoProviderT,
  userT,
  desc,
  or,
} from "common-db";
import { getDB } from "$lib/server/db";
import { hasFeature } from "$lib/server/license";
import { infoClient } from "$lib/server/info-client";
import { serverEnv } from "$lib/server/serverenv";
import { semver } from "bun";
import { version as currentVersion } from "../../../../../../package.json";

export type CheckStatus = "pass" | "warn" | "fail";
export type CheckResult = { status: CheckStatus; detail: string };

export type ComplianceFramework = "GDPR" | "EU AI Act" | "NIS2";

export type ComplianceCheckDefinition = {
  id: string;
  kind: "automated" | "organizational";
  /** Regulatory frameworks this evidence item serves. */
  frameworks: ComplianceFramework[];
  /** Evidence artifact ids from COMPLIANCE.md §4 (E1–E12). */
  evidenceIds: string[];
  articleRef: string;
  title: string;
  explanation: string;
  run?: (organizationId: string) => Promise<CheckResult>;
};

const DAY_MS = 24 * 60 * 60_000;

async function checkRetentionConfigured(organizationId: string): Promise<CheckResult> {
  const [policy] = await getDB()
    .select()
    .from(retentionPolicyT)
    .where(eq(retentionPolicyT.organizationId, organizationId))
    .limit(1);
  if (!policy) {
    return { status: "fail", detail: "No retention policy configured. Inference logs are kept forever by default." };
  }
  if (policy.apiCallRetentionDays === null) {
    return { status: "warn", detail: "Policy exists but API call logs are kept forever. Your DPO must explicitly justify unlimited retention." };
  }
  return { status: "pass", detail: `API call logs are deleted after ${policy.apiCallRetentionDays} days.` };
}

async function checkRetentionEnforced(organizationId: string): Promise<CheckResult> {
  const [policy] = await getDB()
    .select({ apiCallRetentionDays: retentionPolicyT.apiCallRetentionDays, createdAt: retentionPolicyT.createdAt })
    .from(retentionPolicyT)
    .where(eq(retentionPolicyT.organizationId, organizationId))
    .limit(1);
  if (!policy || policy.apiCallRetentionDays === null) {
    return { status: "warn", detail: "Not applicable until a retention period is configured." };
  }
  const [lastRun] = await getDB()
    .select()
    .from(retentionRunT)
    .where(eq(retentionRunT.organizationId, organizationId))
    .orderBy(desc(retentionRunT.startedAt))
    .limit(1);
  if (!lastRun) {
    return Date.now() - policy.createdAt.getTime() < DAY_MS
      ? { status: "warn", detail: "Policy is new; the first purge run is pending (runs daily)." }
      : { status: "fail", detail: "No purge run recorded although a policy is configured. Check that the dashboard service is running." };
  }
  if (lastRun.error) {
    return { status: "warn", detail: `Last purge run reported an error: ${lastRun.error}` };
  }
  if (Date.now() - lastRun.startedAt.getTime() > 2 * DAY_MS) {
    return { status: "fail", detail: "Last purge run is older than 48 hours. Enforcement evidence has a gap." };
  }
  return { status: "pass", detail: `Last purge ran ${lastRun.startedAt.toISOString().slice(0, 16)}Z and deleted ${lastRun.deletedApiCalls} calls.` };
}

async function checkAuditLogActive(organizationId: string): Promise<CheckResult> {
  const [row] = await getDB()
    .select({ entries: count() })
    .from(auditLogT)
    .where(and(
      eq(auditLogT.organizationId, organizationId),
      gte(auditLogT.createdAt, new Date(Date.now() - 30 * DAY_MS)),
    ));
  const entries = row?.entries ?? 0;
  if (!hasFeature("audit-log")) {
    return { status: "warn", detail: `Events are being recorded (${entries} in the last 30 days) but reviewing them requires the audit-log license feature.` };
  }
  if (entries === 0) {
    return { status: "warn", detail: "No administrative actions recorded in the last 30 days." };
  }
  return { status: "pass", detail: `${entries} administrative events recorded in the last 30 days.` };
}

async function checkModelsFromCatalog(organizationId: string): Promise<CheckResult> {
  const deployments = await getDB()
    .select({ specifier: modelDeploymentT.specifier, publicSpecifier: modelDeploymentT.publicSpecifier })
    .from(modelDeploymentT)
    .where(and(
      eq(modelDeploymentT.organizationId, organizationId),
      eq(modelDeploymentT.enabled, true),
      isNull(modelDeploymentT.deletedAt),
    ));
  if (deployments.length === 0) {
    return { status: "pass", detail: "No enabled model deployments." };
  }
  if (!infoClient) {
    return { status: "warn", detail: "Model catalog is unavailable; provenance cannot be verified." };
  }
  const client = infoClient;
  const statuses = await Promise.all(deployments.map(async (d) => {
    if (!d.specifier) return { name: d.publicSpecifier, found: false, hasSource: false };
    const status = await client.fetchModelStatus({ kind: "canonical", specifier: d.specifier });
    if (status.status !== "found") return { name: d.publicSpecifier, found: false, hasSource: false };
    return { name: d.publicSpecifier, found: true, hasSource: Boolean(status.model.url) };
  }));
  const missing = statuses.filter((s) => !s.found);
  if (missing.length > 0) {
    return { status: "fail", detail: `Not in the model catalog: ${missing.map((m) => m.name).join(", ")}. Provenance is undocumented.` };
  }
  const noSource = statuses.filter((s) => !s.hasSource);
  if (noSource.length > 0) {
    return { status: "warn", detail: `No upstream source link in the catalog: ${noSource.map((m) => m.name).join(", ")}.` };
  }
  return { status: "pass", detail: `All ${deployments.length} enabled models come from the catalog with documented upstream sources.` };
}

async function checkMfaOrSso(organizationId: string): Promise<CheckResult> {
  const db = getDB();
  const [ssoProvider] = await db
    .select({ id: ssoProviderT.id })
    .from(ssoProviderT)
    .where(or(eq(ssoProviderT.organizationId, organizationId), isNull(ssoProviderT.organizationId)))
    .limit(1);
  if (ssoProvider) {
    return { status: "pass", detail: "An SSO provider is configured; authentication is delegated to your identity provider." };
  }
  const members = await db
    .select({ userId: userT.id, twoFactorEnabled: userT.twoFactorEnabled, passkeyId: passkeyT.id })
    .from(memberT)
    .innerJoin(userT, eq(userT.id, memberT.userId))
    .leftJoin(passkeyT, eq(passkeyT.userId, userT.id))
    .where(eq(memberT.organizationId, organizationId));
  const byUser = new Map<string, boolean>();
  for (const m of members) {
    byUser.set(m.userId, (byUser.get(m.userId) ?? false) || Boolean(m.twoFactorEnabled) || m.passkeyId !== null);
  }
  const unprotected = [...byUser.values()].filter((ok) => !ok).length;
  if (unprotected > 0) {
    return { status: "warn", detail: `${unprotected} of ${byUser.size} members have neither 2FA nor a passkey, and no SSO provider is configured.` };
  }
  return { status: "pass", detail: `All ${byUser.size} members use 2FA or passkeys.` };
}

async function checkLoggingConsent(organizationId: string): Promise<CheckResult> {
  const db = getDB();
  const [keys] = await db
    .select({ total: count() })
    .from(aiApiKeyT)
    .where(and(eq(aiApiKeyT.organizationId, organizationId), eq(aiApiKeyT.enabled, true), isNull(aiApiKeyT.deletedAt)));
  const [collecting] = await db
    .select({ total: count() })
    .from(aiApiKeyT)
    .where(and(
      eq(aiApiKeyT.organizationId, organizationId),
      eq(aiApiKeyT.enabled, true),
      eq(aiApiKeyT.collectData, true),
      isNull(aiApiKeyT.deletedAt),
    ));
  const totalKeys = keys?.total ?? 0;
  const collectingKeys = collecting?.total ?? 0;
  if (collectingKeys === 0) {
    return { status: "pass", detail: totalKeys === 0 ? "No enabled API keys." : "No enabled API key stores inference content." };
  }
  const [policy] = await db
    .select({ apiCallRetentionDays: retentionPolicyT.apiCallRetentionDays })
    .from(retentionPolicyT)
    .where(eq(retentionPolicyT.organizationId, organizationId))
    .limit(1);
  if (!policy || policy.apiCallRetentionDays === null) {
    return { status: "warn", detail: `${collectingKeys} of ${totalKeys} enabled keys store full prompts and completions without a retention limit.` };
  }
  return { status: "pass", detail: `${collectingKeys} of ${totalKeys} enabled keys store inference content, bounded by the ${policy.apiCallRetentionDays}-day retention policy.` };
}

async function checkNoStaleKeys(organizationId: string): Promise<CheckResult> {
  const cutoff = new Date(Date.now() - 365 * DAY_MS);
  const [stale] = await getDB()
    .select({ total: count() })
    .from(aiApiKeyT)
    .where(and(
      eq(aiApiKeyT.organizationId, organizationId),
      eq(aiApiKeyT.enabled, true),
      isNull(aiApiKeyT.deletedAt),
      lt(aiApiKeyT.createdAt, cutoff),
    ));
  const staleKeys = stale?.total ?? 0;
  if (staleKeys > 0) {
    return { status: "warn", detail: `${staleKeys} enabled API key(s) are older than one year. Rotate long-lived credentials.` };
  }
  return { status: "pass", detail: "No enabled API keys older than one year." };
}

/**
 * NIS2 Art. 21(2)(e): timely security updates are part of vulnerability
 * handling. Compares the running version against the newest one published
 * on the customer's infoserver (works air-gapped via the local mirror).
 */
async function checkPlatformUpToDate(): Promise<CheckResult> {
  try {
    const res = await fetch(new URL("/version.json", serverEnv.INFOSERVER_URL), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { status: "warn", detail: "Update status could not be verified: infoserver did not report a version." };
    }
    const json = (await res.json()) as { version?: unknown };
    if (typeof json.version !== "string") {
      return { status: "warn", detail: "Update status could not be verified: invalid version response." };
    }
    if (semver.order(json.version, currentVersion) === 1) {
      return { status: "warn", detail: `Version ${json.version} is available; this installation runs ${currentVersion}. Apply security updates in a timely manner.` };
    }
    return { status: "pass", detail: `Running the newest available version (${currentVersion}).` };
  } catch {
    return { status: "warn", detail: "Update status could not be verified: infoserver unreachable." };
  }
}

export const COMPLIANCE_CHECKS: ComplianceCheckDefinition[] = [
  {
    id: "retention-configured",
    frameworks: ["GDPR"],
    kind: "automated",
    evidenceIds: ["E4"],
    articleRef: "Art. 5(1)(e) GDPR",
    title: "Retention policy configured",
    explanation: "GDPR requires storage limitation: personal data (including prompts and completions in inference logs) may only be kept as long as needed. Auditors ask for a retention policy differentiated per data category.",
    run: checkRetentionConfigured,
  },
  {
    id: "retention-enforced",
    frameworks: ["GDPR"],
    kind: "automated",
    evidenceIds: ["E4"],
    articleRef: "Art. 5(2) GDPR (accountability)",
    title: "Retention policy enforced",
    explanation: "A written policy is not enough: the controller carries the burden of proving safeguards actually work. Recorded purge runs are the enforcement evidence the audit pack includes.",
    run: checkRetentionEnforced,
  },
  {
    id: "audit-log-active",
    frameworks: ["GDPR", "NIS2"],
    kind: "automated",
    evidenceIds: ["E11"],
    articleRef: "Art. 32 GDPR · Art. 21(2)(b) NIS2",
    title: "Administrative audit trail active",
    explanation: "Auditors ask who can access and change the AI system, and for records proving it. The audit log records deployments, key management, member changes, and data exports.",
    run: checkAuditLogActive,
  },
  {
    id: "models-from-catalog",
    frameworks: ["EU AI Act", "NIS2"],
    kind: "automated",
    evidenceIds: ["E10", "E12"],
    articleRef: "Commission GPAI guidelines (July 2025) · Art. 21(2)(i) NIS2 (asset management)",
    title: "Model provenance documented",
    explanation: "Your deployer (not GPAI provider) position under the EU AI Act rests on running unmodified models with documented provenance. Models outside the catalog have no documented upstream source.",
    run: checkModelsFromCatalog,
  },
  {
    id: "mfa-or-sso",
    frameworks: ["GDPR", "NIS2"],
    kind: "automated",
    evidenceIds: ["E3", "E11"],
    articleRef: "Art. 32 GDPR · Art. 21(2)(j) NIS2 (multi-factor authentication)",
    title: "Strong authentication",
    explanation: "Technical and organizational measures must match the risk of the processed data. Access to inference logs should require a second factor or be delegated to your identity provider via SSO.",
    run: checkMfaOrSso,
  },
  {
    id: "logging-consent-reviewed",
    frameworks: ["GDPR"],
    kind: "automated",
    evidenceIds: ["E1"],
    articleRef: "Art. 5(1)(c) GDPR (data minimisation)",
    title: "Inference logging reviewed",
    explanation: "Each API key controls whether full prompts and completions are stored. Keys that store content should be a deliberate choice, covered by your records of processing and bounded by retention.",
    run: checkLoggingConsent,
  },
  {
    id: "no-stale-admin-keys",
    frameworks: ["GDPR", "NIS2"],
    kind: "automated",
    evidenceIds: ["E3"],
    articleRef: "Art. 32 GDPR · Art. 21(2)(i) NIS2 (access control)",
    title: "Credential hygiene",
    explanation: "Long-lived credentials accumulate exposure risk. Auditors check for rotation practices on keys that grant access to the AI system.",
    run: checkNoStaleKeys,
  },
  {
    id: "dpia",
    frameworks: ["GDPR"],
    kind: "organizational",
    evidenceIds: ["E2"],
    articleRef: "Art. 35 GDPR",
    title: "Data protection impact assessment (DPIA)",
    explanation: "German DPAs state a DPIA will frequently be required for AI deployments. Auditors ask for the full DPIA including proof of DPO involvement and periodic review deadlines. Set a review date when uploading.",
  },
  {
    id: "usage-policy",
    frameworks: ["GDPR", "EU AI Act"],
    kind: "organizational",
    evidenceIds: ["E8"],
    articleRef: "DSK Orientierungshilfe KI, Rn. 36",
    title: "AI usage policy",
    explanation: "Documented internal instructions on whether, under which conditions, and for which purposes which AI applications may be used by employees.",
  },
  {
    id: "training-records",
    frameworks: ["EU AI Act", "GDPR", "NIS2"],
    kind: "organizational",
    evidenceIds: ["E9"],
    articleRef: "Art. 4 EU AI Act · Art. 20(2), 21(2)(g) NIS2",
    title: "AI literacy & security training records",
    explanation: "AI literacy is binding since February 2025 and requires role-tailored training. For NIS2-regulated entities, basic cyber hygiene training (including for management) is additionally mandatory. Generic awareness material is insufficient; keep internal training records as evidence.",
  },
  {
    id: "due-diligence",
    frameworks: ["GDPR", "EU AI Act"],
    kind: "organizational",
    evidenceIds: ["E7"],
    articleRef: "EDPB Opinion 28/2024, paras 129–130",
    title: "Model due-diligence assessment",
    explanation: "A documented assessment that the models you deploy were not developed through unlawful processing of personal data: source of training data, known supervisory authority or court findings.",
  },
  {
    id: "breach-procedure",
    frameworks: ["GDPR"],
    kind: "organizational",
    evidenceIds: ["E5"],
    articleRef: "Art. 33(5) GDPR",
    title: "Breach documentation procedure",
    explanation: "A documented procedure for detecting, reporting, and documenting personal data breaches involving the AI system, including the 72-hour notification path.",
  },
  {
    id: "dsr-procedure",
    frameworks: ["GDPR"],
    kind: "organizational",
    evidenceIds: ["E6"],
    articleRef: "Art. 15–22 GDPR",
    title: "Data subject rights procedure",
    explanation: "Working procedures for access, rectification, and erasure requests covering inference logs. Note: per DSK guidance, suppressing outputs via filters does not generally constitute erasure.",
  },
  {
    id: "platform-up-to-date",
    frameworks: ["NIS2"],
    kind: "automated",
    evidenceIds: ["E16"],
    articleRef: "Art. 21(2)(e) NIS2 (vulnerability handling)",
    title: "Platform security updates",
    explanation: "NIS2 requires security in maintenance, including vulnerability handling. Running the newest published platform version is the timely-update evidence; release integrity is verified via published SHA-256 checksums.",
    run: checkPlatformUpToDate,
  },
  {
    id: "incident-response-plan",
    frameworks: ["NIS2"],
    kind: "organizational",
    evidenceIds: ["E13"],
    articleRef: "Art. 21(2)(b), Art. 23 NIS2",
    title: "Incident response & reporting plan",
    explanation: "Applies if your organization is a NIS2 essential or important entity: a documented incident-handling procedure covering the staged reporting cascade — early warning within 24 hours, incident notification within 72 hours, final report within one month — to your CSIRT or national authority (BSI in Germany). The platform's audit trail and logs feed incident detection and the report timeline.",
  },
  {
    id: "business-continuity",
    frameworks: ["NIS2"],
    kind: "organizational",
    evidenceIds: ["E14"],
    articleRef: "Art. 21(2)(c) NIS2",
    title: "Business continuity & backup plan",
    explanation: "Applies if your organization is a NIS2 essential or important entity: documented backup management, disaster recovery, and crisis management covering the AI platform's database and object store (both customer-managed).",
  },
  {
    id: "risk-analysis-policy",
    frameworks: ["NIS2"],
    kind: "organizational",
    evidenceIds: ["E15"],
    articleRef: "Art. 21(2)(a), 21(2)(f) NIS2",
    title: "Risk analysis & security policy (ISMS)",
    explanation: "Applies if your organization is a NIS2 essential or important entity: the information-system security policy and risk analysis covering the AI platform, plus a procedure to assess the effectiveness of the measures. ENISA's Technical Implementation Guidance (June 2025) and ISO/IEC 27001 mappings define the expected evidence.",
  },
];

export const ORGANIZATIONAL_KINDS = new Set(
  COMPLIANCE_CHECKS.filter((c) => c.kind === "organizational").map((c) => c.id),
);

export type PostureCheck = {
  id: string;
  kind: "automated" | "organizational";
  frameworks: ComplianceFramework[];
  evidenceIds: string[];
  articleRef: string;
  title: string;
  explanation: string;
  status: CheckStatus;
  detail: string;
  artifact?: {
    id: string;
    fileName: string;
    size: number;
    note: string | null;
    reviewBy: string | null;
    updatedAt: Date;
  };
};

export type PostureReport = {
  checks: PostureCheck[];
  summary: { pass: number; warn: number; fail: number; total: number };
  generatedAt: Date;
};

const CACHE_TTL_MS = 5 * 60_000;
const reportCache = new Map<string, { at: number; report: PostureReport }>();

/** Call when underlying state changes outside the cache window (artifact upload, policy change). */
export function invalidatePostureCache(organizationId: string): void {
  reportCache.delete(organizationId);
}

function artifactStatus(artifact: { reviewBy: string | null }): CheckResult {
  if (artifact.reviewBy && new Date(artifact.reviewBy).getTime() < Date.now()) {
    return { status: "warn", detail: "Uploaded, but the self-declared review date has passed. Review and re-upload." };
  }
  return { status: "pass", detail: "Document uploaded." };
}

export async function getPostureReport(organizationId: string): Promise<PostureReport> {
  const cached = reportCache.get(organizationId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.report;

  const artifacts = await getDB()
    .select()
    .from(complianceArtifactT)
    .where(eq(complianceArtifactT.organizationId, organizationId));
  const artifactsByKind = new Map(artifacts.map((a) => [a.kind, a]));

  const checks = await Promise.all(COMPLIANCE_CHECKS.map(async (def): Promise<PostureCheck> => {
    const { run, ...meta } = def;
    let result: CheckResult;
    let artifact: PostureCheck["artifact"];
    if (def.kind === "automated" && run) {
      result = await run(organizationId).catch((err: unknown) => ({
        status: "warn" as const,
        detail: `Check could not run: ${err instanceof Error ? err.message : String(err)}`,
      }));
    } else {
      const uploaded = artifactsByKind.get(def.id);
      if (uploaded) {
        result = artifactStatus(uploaded);
        artifact = {
          id: uploaded.id,
          fileName: uploaded.fileName,
          size: uploaded.size,
          note: uploaded.note,
          reviewBy: uploaded.reviewBy,
          updatedAt: uploaded.updatedAt,
        };
      } else {
        result = { status: "fail", detail: "Not uploaded yet. This document cannot be generated by the platform; it requires your organization's input." };
      }
    }
    return { ...meta, ...result, artifact };
  }));

  const summary = {
    pass: checks.filter((c) => c.status === "pass").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
    total: checks.length,
  };
  const report: PostureReport = { checks, summary, generatedAt: new Date() };
  reportCache.set(organizationId, { at: Date.now(), report });
  return report;
}
