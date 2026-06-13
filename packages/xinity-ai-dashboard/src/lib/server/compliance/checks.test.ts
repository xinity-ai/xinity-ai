/**
 * Integration tests for the compliance posture check engine. The check
 * functions read live platform state, so this drives the public
 * getPostureReport against a real Postgres with seeded state and asserts
 * each org-scoped check's pass/warn/fail thresholds. Loads the dashboard
 * .env so checks.ts (which pulls in license + infoserver) imports cleanly.
 * Requires DB_CONNECTION_URL (docker stack).
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
  retentionPolicyT,
  retentionRunT,
  complianceArtifactT,
  preconfigureDB,
  inArray,
} from "common-db";

function loadEnv() {
  // The dashboard .env is the exact set the preview server boots with, so
  // serverenv (parsed when checks.ts is imported) is guaranteed to validate.
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
}
loadEnv();

if (!process.env.DB_CONNECTION_URL) {
  throw new Error("DB_CONNECTION_URL not set; start the docker stack and configure the dashboard .env");
}

// Imported after env load so serverenv parses.
const { getPostureReport, invalidatePostureCache } = await import("./checks");

const db = preconfigureDB(process.env.DB_CONNECTION_URL).getDB();
const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];
const DAY_MS = 24 * 60 * 60_000;

async function makeOrg(): Promise<string> {
  const id = `checks-test-${randomUUID()}`;
  await db.insert(organizationT).values({ id, name: "Checks Test", slug: id });
  createdOrgIds.push(id);
  return id;
}

async function addMember(organizationId: string, opts: { twoFactor?: boolean } = {}) {
  const userId = `checks-user-${randomUUID()}`;
  await db.insert(userT).values({
    id: userId,
    name: "Member",
    email: `${userId}@test.local`,
    emailVerified: true,
    twoFactorEnabled: opts.twoFactor ?? false,
  });
  createdUserIds.push(userId);
  await db.insert(memberT).values({ id: randomUUID(), userId, organizationId, role: "member" });
}

async function addApiKey(organizationId: string, opts: { collectData?: boolean; ageDays?: number } = {}) {
  await db.insert(aiApiKeyT).values({
    specifier: `sk_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    organizationId,
    name: "key",
    hash: "x",
    enabled: true,
    collectData: opts.collectData ?? true,
    createdAt: new Date(Date.now() - (opts.ageDays ?? 0) * DAY_MS),
  });
}

async function setPolicy(organizationId: string, apiCallRetentionDays: number | null, ageDays = 0) {
  await db.insert(retentionPolicyT).values({
    organizationId,
    apiCallRetentionDays,
    mediaRetentionDays: null,
    createdAt: new Date(Date.now() - ageDays * DAY_MS),
  }).onConflictDoUpdate({
    target: retentionPolicyT.organizationId,
    set: { apiCallRetentionDays },
  });
}

async function addRun(organizationId: string, opts: { ageHours?: number; error?: string | null } = {}) {
  await db.insert(retentionRunT).values({
    organizationId,
    startedAt: new Date(Date.now() - (opts.ageHours ?? 0) * 60 * 60_000),
    finishedAt: new Date(),
    deletedApiCalls: 0,
    deletedMediaObjects: 0,
    error: opts.error ?? null,
  });
}

async function addArtifact(organizationId: string, kind: string, reviewBy: string | null = null) {
  await db.insert(complianceArtifactT).values({
    organizationId,
    kind,
    fileName: `${kind}.pdf`,
    mimeType: "application/pdf",
    data: Buffer.from("demo"),
    size: 4,
    reviewBy,
  });
}

async function statusOf(organizationId: string, checkId: string) {
  invalidatePostureCache(organizationId);
  const report = await getPostureReport(organizationId);
  const check = report.checks.find((c) => c.id === checkId);
  if (!check) throw new Error(`check ${checkId} not found`);
  return check;
}

afterAll(async () => {
  if (createdOrgIds.length) await db.delete(organizationT).where(inArray(organizationT.id, createdOrgIds));
  if (createdUserIds.length) await db.delete(userT).where(inArray(userT.id, createdUserIds));
});

describe("posture check engine", () => {
  test("retention-configured: fail without policy, warn for keep-forever, pass with days", async () => {
    const org = await makeOrg();
    expect((await statusOf(org, "retention-configured")).status).toBe("fail");

    await setPolicy(org, null);
    expect((await statusOf(org, "retention-configured")).status).toBe("warn");

    await setPolicy(org, 30);
    expect((await statusOf(org, "retention-configured")).status).toBe("pass");
  });

  test("retention-enforced: fail when overdue with no run, pass with a recent clean run, warn on run error", async () => {
    const org = await makeOrg();
    await setPolicy(org, 30, /* ageDays */ 5); // policy older than the grace day, no run yet
    expect((await statusOf(org, "retention-enforced")).status).toBe("fail");

    await addRun(org, { ageHours: 1 });
    expect((await statusOf(org, "retention-enforced")).status).toBe("pass");

    await db.delete(retentionRunT).where(inArray(retentionRunT.organizationId, [org]));
    await addRun(org, { ageHours: 1, error: "boom" });
    expect((await statusOf(org, "retention-enforced")).status).toBe("warn");
  });

  test("logging-consent-reviewed: warn when content-logging keys lack a retention bound, pass once bounded", async () => {
    const org = await makeOrg();
    await addApiKey(org, { collectData: true });
    expect((await statusOf(org, "logging-consent-reviewed")).status).toBe("warn");

    await setPolicy(org, 30);
    expect((await statusOf(org, "logging-consent-reviewed")).status).toBe("pass");
  });

  test("logging-consent-reviewed: pass when no key stores content", async () => {
    const org = await makeOrg();
    await addApiKey(org, { collectData: false });
    expect((await statusOf(org, "logging-consent-reviewed")).status).toBe("pass");
  });

  test("mfa-or-sso: warn for a member without 2FA, pass when 2FA is enabled", async () => {
    const orgA = await makeOrg();
    await addMember(orgA, { twoFactor: false });
    expect((await statusOf(orgA, "mfa-or-sso")).status).toBe("warn");

    const orgB = await makeOrg();
    await addMember(orgB, { twoFactor: true });
    expect((await statusOf(orgB, "mfa-or-sso")).status).toBe("pass");
  });

  test("no-stale-admin-keys: warn for a key older than a year, pass when recent", async () => {
    const orgOld = await makeOrg();
    await addApiKey(orgOld, { ageDays: 400 });
    expect((await statusOf(orgOld, "no-stale-admin-keys")).status).toBe("warn");

    const orgNew = await makeOrg();
    await addApiKey(orgNew, { ageDays: 10 });
    expect((await statusOf(orgNew, "no-stale-admin-keys")).status).toBe("pass");
  });

  test("organizational artifact: fail when missing, pass when uploaded, warn when the review date has passed", async () => {
    const org = await makeOrg();
    expect((await statusOf(org, "dpia")).status).toBe("fail");

    await addArtifact(org, "dpia");
    expect((await statusOf(org, "dpia")).status).toBe("pass");

    await db.delete(complianceArtifactT).where(inArray(complianceArtifactT.organizationId, [org]));
    await addArtifact(org, "dpia", "2020-01-01"); // review date in the past
    expect((await statusOf(org, "dpia")).status).toBe("warn");
  });

  test("audit-log-active without the license feature reports warn (events recorded, viewing gated)", async () => {
    const org = await makeOrg();
    const check = await statusOf(org, "audit-log-active");
    // No LICENSE_KEY in the test env => free tier => recording on, reviewing gated.
    expect(check.status).toBe("warn");
    expect(check.frameworks).toContain("NIS2");
  });

  test("report summary counts are internally consistent", async () => {
    const org = await makeOrg();
    await setPolicy(org, 30);
    const report = await getPostureReport(org);
    const { pass, warn, fail, total } = report.summary;
    expect(pass + warn + fail).toBe(total);
    expect(total).toBe(report.checks.length);
  });
});
