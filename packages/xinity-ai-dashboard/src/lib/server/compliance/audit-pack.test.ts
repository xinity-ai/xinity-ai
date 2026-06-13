/**
 * Integration tests for audit-pack assembly. Covers the parts previously
 * only checked by manually unzipping a generated pack: the reporting-period
 * window (incl. since-deleted deployments still appearing in range), secret
 * redaction (key hashes and SSO configs must never reach the pack), and the
 * explicit open-gaps list. Loads the dashboard .env so audit-pack.ts imports
 * cleanly. Requires DB_CONNECTION_URL (docker stack).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  organizationT,
  userT,
  memberT,
  aiApiKeyT,
  modelDeploymentT,
  ssoProviderT,
  retentionPolicyT,
  retentionRunT,
  usageSummaryT,
  complianceArtifactT,
  auditLogT,
  preconfigureDB,
  inArray,
} from "common-db";

for (const rel of ["../../../../.env", "../../../../../../.env"]) {
  const envPath = join(import.meta.dir, rel);
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!process.env[key]) process.env[key] = trimmed.slice(eqIdx + 1).trim();
  }
}
if (!process.env.DB_CONNECTION_URL) {
  throw new Error("DB_CONNECTION_URL not set; start the docker stack and configure the dashboard .env");
}

const { assembleAuditPack, artifactEntryName, LEGAL_MAPPING_VERSION } = await import("./audit-pack");

const db = preconfigureDB(process.env.DB_CONNECTION_URL).getDB();
const DAY_MS = 24 * 60 * 60_000;
const SECRET_HASH = "SUPER-SECRET-KEY-HASH-zzz";
const OIDC_SECRET = "OIDC-CLIENT-SECRET-abc";

let org: string;
let from: Date;
let to: Date;

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS);
}

const apiKeySpecifier = `sk_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
let u1 = "";

beforeAll(async () => {
  to = new Date();
  from = daysAgo(30);
  org = `auditpack-test-${randomUUID()}`;
  await db.insert(organizationT).values({ id: org, name: "Audit Pack Test Org", slug: org });

  u1 = `apuser-${randomUUID()}`;
  const u2 = `apuser-${randomUUID()}`;
  await db.insert(userT).values([
    { id: u1, name: "A", email: `${u1}@t.local`, emailVerified: true, twoFactorEnabled: true },
    { id: u2, name: "B", email: `${u2}@t.local`, emailVerified: true, twoFactorEnabled: false },
  ]);
  await db.insert(memberT).values([
    { id: randomUUID(), userId: u1, organizationId: org, role: "owner" },
    { id: randomUUID(), userId: u2, organizationId: org, role: "member" },
  ]);

  // Deployments: two in-window (one active, one deleted within window), two out.
  await db.insert(modelDeploymentT).values([
    { organizationId: org, name: "Active", publicSpecifier: "active-deploy", modelSpecifier: "m", specifier: null, createdAt: daysAgo(20) },
    { organizationId: org, name: "Removed", publicSpecifier: "removed-deploy", modelSpecifier: "m", specifier: null, createdAt: daysAgo(20), deletedAt: daysAgo(10) },
    { organizationId: org, name: "Future", publicSpecifier: "future-deploy", modelSpecifier: "m", specifier: null, createdAt: new Date(Date.now() + 5 * DAY_MS) },
    { organizationId: org, name: "OldGone", publicSpecifier: "oldgone-deploy", modelSpecifier: "m", specifier: null, createdAt: daysAgo(60), deletedAt: daysAgo(50) },
  ]);

  await db.insert(aiApiKeyT).values({
    specifier: apiKeySpecifier, organizationId: org, name: "prod-key", hash: SECRET_HASH, collectData: true,
  });

  await db.insert(ssoProviderT).values({
    id: randomUUID(), userId: u1, providerId: "test-idp", issuer: "https://idp.example.com", domain: "example.com",
    organizationId: org, oidcConfig: JSON.stringify({ clientSecret: OIDC_SECRET }),
  });

  await db.insert(retentionPolicyT).values({ organizationId: org, apiCallRetentionDays: 30, mediaRetentionDays: null });

  await db.insert(retentionRunT).values([
    { organizationId: org, startedAt: daysAgo(5), finishedAt: daysAgo(5), deletedApiCalls: 7, deletedMediaObjects: 0 }, // in
    { organizationId: org, startedAt: daysAgo(60), finishedAt: daysAgo(60), deletedApiCalls: 3, deletedMediaObjects: 0 }, // out
  ]);

  await db.insert(usageSummaryT).values([
    { date: daysAgo(5).toISOString().slice(0, 10), organizationId: org, apiKeyId: randomUUID(), model: "model-in", totalCalls: 10, inputTokens: 100, outputTokens: 50 },
    { date: daysAgo(60).toISOString().slice(0, 10), organizationId: org, apiKeyId: randomUUID(), model: "model-out", totalCalls: 99, inputTokens: 1, outputTokens: 1 },
  ]);

  await db.insert(auditLogT).values([
    { organizationId: org, action: "deployment.create", resourceType: "modelDeployment", createdAt: daysAgo(5) }, // in
    { organizationId: org, action: "apiKey.create", resourceType: "aiApiKey", createdAt: daysAgo(60) }, // out
  ]);

  await db.insert(complianceArtifactT).values({
    organizationId: org, kind: "dpia", fileName: "dpia.pdf", mimeType: "application/pdf", data: Buffer.from("demo-dpia"), size: 9,
  });
});

afterAll(async () => {
  // model_deployment's org FK is restrict (you can't drop an org with live
  // deployments), so remove deployments before the org; the rest cascades.
  await db.delete(modelDeploymentT).where(inArray(modelDeploymentT.organizationId, [org]));
  await db.delete(organizationT).where(inArray(organizationT.id, [org]));
});

describe("audit-pack assembly", () => {
  test("deployment register includes in-window deployments, including ones deleted within the window", async () => {
    const { data } = await assembleAuditPack(org, from, to);
    const names = data.modelRegister.deployments.map((d) => d.publicSpecifier).sort();
    expect(names).toEqual(["active-deploy", "removed-deploy"]);
    const removed = data.modelRegister.deployments.find((d) => d.publicSpecifier === "removed-deploy");
    expect(removed?.deletedAt).not.toBeNull(); // shown as removed, not silently dropped
  });

  test("time-windowed sections exclude out-of-range rows", async () => {
    const { data } = await assembleAuditPack(org, from, to);
    expect(data.retention.runs.length).toBe(1);
    expect(data.retention.runs[0].deletedApiCalls).toBe(7);
    expect(data.modelRegister.usage.map((u) => u.model)).toEqual(["model-in"]);
    expect(data.access.auditTotalInRange).toBe(1);
    expect(data.access.auditEntries.length).toBe(1);
    expect(data.access.auditEntries[0].action).toBe("deployment.create");
  });

  test("secrets never reach the pack (key hash, SSO config)", async () => {
    const { data } = await assembleAuditPack(org, from, to);
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(SECRET_HASH);
    expect(serialized).not.toContain(OIDC_SECRET);
    // ROPA exposes key identity but not the hash.
    const key = data.ropa.apiKeys.find((k) => k.name === "prod-key");
    expect(key).toBeTruthy();
    expect(key).not.toHaveProperty("hash");
    expect(key?.specifier).toBe(apiKeySpecifier);
    // SSO entries carry only provider/domain/issuer.
    expect(Object.keys(data.toms.ssoProviders[0]).sort()).toEqual(["domain", "issuer", "providerId"]);
  });

  test("TOMs reflects member authentication and the RBAC matrix", async () => {
    const { data } = await assembleAuditPack(org, from, to);
    expect(data.toms.memberAuth.total).toBe(2);
    expect(data.toms.memberAuth.withTwoFactor).toBe(1);
    expect(data.toms.rbacMatrix.length).toBeGreaterThan(0);
    expect(data.toms.auditLogActive).toBe(true);
  });

  test("ROPA retention reflects the policy", async () => {
    const { data } = await assembleAuditPack(org, from, to);
    expect(data.ropa.retentionDays).toEqual({ apiCall: 30, media: null });
  });

  test("uploaded artifacts are bundled; missing ones are listed as explicit gaps", async () => {
    const { data, artifactFiles } = await assembleAuditPack(org, from, to);
    expect(data.artifacts.map((a) => a.kind)).toEqual(["dpia"]);
    expect(data.missingArtifactKinds).not.toContain("dpia");
    expect(data.missingArtifactKinds).toContain("usage-policy");
    expect(data.missingArtifactKinds).toContain("incident-response-plan"); // a NIS2 artifact

    const file = artifactFiles.find((f) => f.kind === "dpia");
    expect(file).toBeTruthy();
    expect(Buffer.from(file!.data).toString()).toBe("demo-dpia");
    expect(artifactEntryName(file!.kind, file!.fileName)).toBe("evidence/artifacts/dpia-dpia.pdf");
  });

  test("cover carries org, posture summary, and a versioned legal mapping", async () => {
    const { data } = await assembleAuditPack(org, from, to);
    expect(data.cover.organizationName).toBe("Audit Pack Test Org");
    expect(data.cover.legalMappingVersion).toBe(LEGAL_MAPPING_VERSION);
    expect(data.cover.platformVersion).toBeTruthy();
    expect(data.cover.posture.total).toBeGreaterThan(0);
  });

  // NOTE: the HTML render (report-html.ts -> AuditPackReport.svelte) is not
  // unit-tested here because `bun test` does not run the Svelte compiler, so
  // the .svelte template cannot be server-rendered. The report is derived
  // purely from the asserted AuditPackData (secret redaction is covered at the
  // data level above), and the rendered output is exercised via the live
  // /compliance/audit-pack endpoint.
});
