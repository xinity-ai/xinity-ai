import {
  aiApiKeyT,
  aiApplicationT,
  aiNodeT,
  and,
  auditLogT,
  complianceArtifactT,
  count,
  countDistinct,
  deploymentConfigT,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  memberT,
  modelDeploymentT,
  organizationT,
  or,
  passkeyT,
  retentionPolicyT,
  retentionRunT,
  sessionT,
  ssoProviderT,
  sql,
  usageSummaryT,
  userT,
} from "common-db";
import { getDB } from "$lib/server/db";
import { infoClient } from "$lib/server/info-client";
import { roles, type RoleName } from "$lib/roles";
import { getPostureReport, type PostureReport } from "./checks";
import { version } from "../../../../../../package.json";

/**
 * Version of the regulation mapping the report sections cite. Bump when
 * COMPLIANCE.md's legal mapping changes (e.g. Digital Omnibus adoption,
 * Art. 50 application) so older packs stay interpretable.
 */
export const LEGAL_MAPPING_VERSION = "2026-06.1";

const AUDIT_EXTRACT_LIMIT = 500;

export type AuditPackData = {
  cover: {
    organizationName: string;
    organizationId: string;
    instanceId: string | null;
    platformVersion: string;
    legalMappingVersion: string;
    generatedAt: Date;
    from: Date;
    to: Date;
    posture: PostureReport["summary"];
  };
  modelRegister: {
    deployments: Array<{
      name: string;
      publicSpecifier: string;
      specifier: string | null;
      enabled: boolean;
      replicas: number;
      createdAt: Date;
      deletedAt: Date | null;
      catalog: { found: boolean; modelName?: string; type?: string; sourceUrl?: string; weightGb?: number };
    }>;
    nodes: Array<{
      host: string;
      machineName: string | null;
      gpuCount: number;
      gpus: unknown;
      driverVersions: unknown;
      available: boolean;
    }>;
    usage: Array<{ model: string; totalCalls: number; loggedCalls: number; inputTokens: number; outputTokens: number }>;
  };
  ropa: {
    applications: Array<{ name: string; description: string | null; createdAt: Date }>;
    apiKeys: Array<{ name: string; specifier: string; enabled: boolean; collectData: boolean; createdAt: Date }>;
    retentionDays: { apiCall: number | null; media: number | null } | null;
  };
  toms: {
    memberAuth: { total: number; withTwoFactor: number; withPasskey: number };
    ssoProviders: Array<{ providerId: string; domain: string; issuer: string }>;
    rbacMatrix: Array<{ role: RoleName; permissions: Record<string, readonly string[]> }>;
    auditLogActive: boolean;
  };
  retention: {
    policy: { apiCallRetentionDays: number | null; mediaRetentionDays: number | null; updatedAt: Date } | null;
    runs: Array<{ startedAt: Date; finishedAt: Date | null; deletedApiCalls: number; deletedMediaObjects: number; error: string | null }>;
  };
  access: {
    members: Array<{ name: string; email: string; role: string; twoFactorEnabled: boolean; passkeys: number }>;
    sessionStats: { sessions: number; distinctIps: number };
    auditEntries: Array<{ createdAt: Date; actorEmail: string | null; action: string; resourceType: string; details: Record<string, unknown> | null }>;
    auditTotalInRange: number;
  };
  artifacts: Array<{
    id: string;
    kind: string;
    fileName: string;
    mimeType: string;
    size: number;
    note: string | null;
    reviewBy: string | null;
    updatedAt: Date;
  }>;
  missingArtifactKinds: string[];
  posture: PostureReport;
};

/** Binary artifact contents for the ZIP, kept out of AuditPackData/evidence JSON. */
export type AuditPackArtifactFile = { kind: string; fileName: string; data: Buffer };

/** ZIP path of an uploaded artifact; shared by the endpoint and the report template. */
export function artifactEntryName(kind: string, fileName: string): string {
  const safe = fileName.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return `evidence/artifacts/${kind}-${safe || "document"}`;
}

async function fetchCatalogMeta(specifier: string | null) {
  if (!specifier || !infoClient) return { found: false } as const;
  try {
    const status = await infoClient.fetchModelStatus({ kind: "canonical", specifier });
    if (status.status !== "found") return { found: false } as const;
    return {
      found: true,
      modelName: status.model.name,
      type: status.model.type,
      sourceUrl: status.model.url,
      weightGb: status.model.weight,
    } as const;
  } catch {
    return { found: false } as const;
  }
}

export async function assembleAuditPack(
  organizationId: string,
  from: Date,
  to: Date,
): Promise<{ data: AuditPackData; artifactFiles: AuditPackArtifactFile[] }> {
  const db = getDB();
  const inRange = { from, to };

  const [
    [org],
    [instance],
    posture,
    deployments,
    nodes,
    usage,
    applications,
    apiKeys,
    [policy],
    runs,
    memberRows,
    ssoProviders,
    [sessionStats],
    auditEntries,
    [auditTotal],
    artifacts,
  ] = await Promise.all([
    db.select().from(organizationT).where(eq(organizationT.id, organizationId)).limit(1),
    db.select().from(deploymentConfigT).limit(1),
    getPostureReport(organizationId),
    // Deployments active at any point in the range, including since-deleted ones.
    db.select().from(modelDeploymentT).where(and(
      eq(modelDeploymentT.organizationId, organizationId),
      lte(modelDeploymentT.createdAt, inRange.to),
      or(isNull(modelDeploymentT.deletedAt), gte(modelDeploymentT.deletedAt, inRange.from)),
    )),
    db.select().from(aiNodeT).where(isNull(aiNodeT.deletedAt)),
    db.select({
      model: usageSummaryT.model,
      totalCalls: sql<number>`sum(${usageSummaryT.totalCalls})::int`,
      loggedCalls: sql<number>`sum(${usageSummaryT.loggedCalls})::int`,
      inputTokens: sql<number>`sum(${usageSummaryT.inputTokens})::bigint`,
      outputTokens: sql<number>`sum(${usageSummaryT.outputTokens})::bigint`,
    }).from(usageSummaryT).where(and(
      eq(usageSummaryT.organizationId, organizationId),
      gte(usageSummaryT.date, inRange.from.toISOString().slice(0, 10)),
      lte(usageSummaryT.date, inRange.to.toISOString().slice(0, 10)),
    )).groupBy(usageSummaryT.model),
    db.select().from(aiApplicationT).where(and(
      eq(aiApplicationT.organizationId, organizationId),
      isNull(aiApplicationT.deletedAt),
    )),
    db.select().from(aiApiKeyT).where(and(
      eq(aiApiKeyT.organizationId, organizationId),
      isNull(aiApiKeyT.deletedAt),
    )),
    db.select().from(retentionPolicyT).where(eq(retentionPolicyT.organizationId, organizationId)).limit(1),
    db.select().from(retentionRunT).where(and(
      eq(retentionRunT.organizationId, organizationId),
      gte(retentionRunT.startedAt, inRange.from),
      lte(retentionRunT.startedAt, inRange.to),
    )).orderBy(desc(retentionRunT.startedAt)),
    db.select({
      name: userT.name,
      email: userT.email,
      role: memberT.role,
      twoFactorEnabled: userT.twoFactorEnabled,
      userId: userT.id,
      passkeys: count(passkeyT.id),
    }).from(memberT)
      .innerJoin(userT, eq(userT.id, memberT.userId))
      .leftJoin(passkeyT, eq(passkeyT.userId, userT.id))
      .where(eq(memberT.organizationId, organizationId))
      .groupBy(userT.id, userT.name, userT.email, memberT.role, userT.twoFactorEnabled),
    db.select({
      providerId: ssoProviderT.providerId,
      domain: ssoProviderT.domain,
      issuer: ssoProviderT.issuer,
    }).from(ssoProviderT).where(or(
      eq(ssoProviderT.organizationId, organizationId),
      isNull(ssoProviderT.organizationId),
    )),
    db.select({
      sessions: count(),
      distinctIps: countDistinct(sessionT.ipAddress),
    }).from(sessionT)
      .innerJoin(memberT, and(eq(memberT.userId, sessionT.userId), eq(memberT.organizationId, organizationId)))
      .where(and(gte(sessionT.createdAt, inRange.from), lte(sessionT.createdAt, inRange.to))),
    db.select({
      createdAt: auditLogT.createdAt,
      actorEmail: auditLogT.actorEmail,
      action: auditLogT.action,
      resourceType: auditLogT.resourceType,
      details: auditLogT.details,
    }).from(auditLogT).where(and(
      eq(auditLogT.organizationId, organizationId),
      gte(auditLogT.createdAt, inRange.from),
      lte(auditLogT.createdAt, inRange.to),
    )).orderBy(desc(auditLogT.createdAt)).limit(AUDIT_EXTRACT_LIMIT),
    db.select({ total: count() }).from(auditLogT).where(and(
      eq(auditLogT.organizationId, organizationId),
      gte(auditLogT.createdAt, inRange.from),
      lte(auditLogT.createdAt, inRange.to),
    )),
    db.select().from(complianceArtifactT).where(eq(complianceArtifactT.organizationId, organizationId)),
  ]);

  if (!org) throw new Error("Organization not found");

  const catalogMetas = await Promise.all(deployments.map((d) => fetchCatalogMeta(d.specifier)));

  const organizationalChecks = posture.checks.filter((c) => c.kind === "organizational");
  const uploadedKinds = new Set(artifacts.map((a) => a.kind));
  const missingArtifactKinds = organizationalChecks
    .filter((c) => !uploadedKinds.has(c.id))
    .map((c) => c.id);

  const data: AuditPackData = {
    cover: {
      organizationName: org.name,
      organizationId,
      instanceId: instance?.instanceId ?? null,
      platformVersion: version,
      legalMappingVersion: LEGAL_MAPPING_VERSION,
      generatedAt: new Date(),
      from,
      to,
      posture: posture.summary,
    },
    modelRegister: {
      deployments: deployments.map((d, i) => ({
        name: d.name,
        publicSpecifier: d.publicSpecifier,
        specifier: d.specifier,
        enabled: d.enabled,
        replicas: d.replicas,
        createdAt: d.createdAt,
        deletedAt: d.deletedAt,
        catalog: catalogMetas[i],
      })),
      nodes: nodes.map((n) => ({
        host: n.host,
        machineName: n.machineName,
        gpuCount: n.gpuCount,
        gpus: n.gpus,
        driverVersions: n.driverVersions,
        available: n.available,
      })),
      usage,
    },
    ropa: {
      applications: applications.map((a) => ({ name: a.name, description: a.description, createdAt: a.createdAt })),
      apiKeys: apiKeys.map((k) => ({
        name: k.name,
        specifier: k.specifier,
        enabled: k.enabled,
        collectData: k.collectData,
        createdAt: k.createdAt,
      })),
      retentionDays: policy
        ? { apiCall: policy.apiCallRetentionDays, media: policy.mediaRetentionDays }
        : null,
    },
    toms: {
      memberAuth: {
        total: memberRows.length,
        withTwoFactor: memberRows.filter((m) => m.twoFactorEnabled).length,
        withPasskey: memberRows.filter((m) => m.passkeys > 0).length,
      },
      ssoProviders,
      rbacMatrix: (Object.keys(roles) as RoleName[]).map((role) => ({
        role,
        permissions: roles[role].statements as Record<string, readonly string[]>,
      })),
      auditLogActive: auditTotal.total > 0,
    },
    retention: {
      policy: policy
        ? { apiCallRetentionDays: policy.apiCallRetentionDays, mediaRetentionDays: policy.mediaRetentionDays, updatedAt: policy.updatedAt }
        : null,
      runs,
    },
    access: {
      members: memberRows.map((m) => ({
        name: m.name,
        email: m.email,
        role: m.role,
        twoFactorEnabled: m.twoFactorEnabled ?? false,
        passkeys: m.passkeys,
      })),
      sessionStats: { sessions: sessionStats?.sessions ?? 0, distinctIps: sessionStats?.distinctIps ?? 0 },
      auditEntries,
      auditTotalInRange: auditTotal.total,
    },
    artifacts: artifacts.map((a) => ({
      id: a.id,
      kind: a.kind,
      fileName: a.fileName,
      mimeType: a.mimeType,
      size: a.size,
      note: a.note,
      reviewBy: a.reviewBy,
      updatedAt: a.updatedAt,
    })),
    missingArtifactKinds,
    posture,
  };

  const artifactFiles: AuditPackArtifactFile[] = artifacts.map((a) => ({
    kind: a.kind,
    fileName: a.fileName,
    data: a.data,
  }));

  return { data, artifactFiles };
}
