/**
 * Integration tests for the data-retention purge logic against a real
 * Postgres. This is the one feature that irreversibly deletes customer
 * data, so the batched delete, cutoff math, media S3-failure path,
 * once-per-day guard, and "never touch usage aggregates" rule all have
 * explicit coverage here. Requires DB_CONNECTION_URL (docker stack).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  organizationT,
  apiCallT,
  mediaObjectT,
  usageEventT,
  retentionPolicyT,
  retentionRunT,
  auditLogT,
  preconfigureDB,
  and,
  count,
  desc,
  eq,
  inArray,
} from "common-db";
import {
  runRetentionCycle,
  purgeOrganization,
  isPurgeDue,
  type DeleteBlob,
  type RetentionDb,
} from "./retention.core";

let db: RetentionDb;
const createdOrgIds: string[] = [];
const DAY_MS = 24 * 60 * 60_000;

const deleteOk: DeleteBlob = async () => true;
const deleteFail: DeleteBlob = async () => false;

function loadRootEnv() {
  if (process.env.DB_CONNECTION_URL) return;
  const envPath = join(import.meta.dir, "../../../../../../.env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!process.env[key]) process.env[key] = trimmed.slice(eqIdx + 1).trim();
  }
}

async function makeOrg(): Promise<string> {
  const id = `retention-test-${randomUUID()}`;
  await db.insert(organizationT).values({ id, name: "Retention Test", slug: id });
  createdOrgIds.push(id);
  return id;
}

async function setPolicy(organizationId: string, apiCallRetentionDays: number | null, mediaRetentionDays: number | null = null) {
  await db.insert(retentionPolicyT).values({ organizationId, apiCallRetentionDays, mediaRetentionDays });
}

async function insertApiCall(organizationId: string, ageDays: number) {
  await db.insert(apiCallT).values({
    organizationId,
    model: "test-model",
    specifiedModel: "test-model",
    duration: 10,
    inputMessages: [{ role: "user", content: "hi" }],
    outputMessage: { role: "assistant", content: "yo" },
    createdAt: new Date(Date.now() - ageDays * DAY_MS),
  });
}

async function insertMedia(organizationId: string, ageDays: number) {
  await db.insert(mediaObjectT).values({
    sha256: randomUUID().replace(/-/g, ""),
    mimeType: "image/png",
    s3Bucket: "test",
    s3Key: `${organizationId}/${randomUUID()}`,
    organizationId,
    size: 100,
    updatedAt: new Date(Date.now() - ageDays * DAY_MS),
  });
}

async function countApiCalls(organizationId: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(apiCallT).where(eq(apiCallT.organizationId, organizationId));
  return r?.n ?? 0;
}
async function countMedia(organizationId: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(mediaObjectT).where(eq(mediaObjectT.organizationId, organizationId));
  return r?.n ?? 0;
}
async function latestRun(organizationId: string) {
  const [r] = await db.select().from(retentionRunT)
    .where(eq(retentionRunT.organizationId, organizationId))
    .orderBy(desc(retentionRunT.startedAt)).limit(1);
  return r;
}
async function countRuns(organizationId: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(retentionRunT).where(eq(retentionRunT.organizationId, organizationId));
  return r?.n ?? 0;
}

beforeAll(() => {
  loadRootEnv();
  if (!process.env.DB_CONNECTION_URL) {
    throw new Error("DB_CONNECTION_URL not set; start the docker stack and copy example.env to .env at the repo root");
  }
  db = preconfigureDB(process.env.DB_CONNECTION_URL).getDB();
});

afterAll(async () => {
  if (!db || createdOrgIds.length === 0) return;
  // Cascade removes api_call, media_object, usage_event, retention_*, audit_log.
  await db.delete(organizationT).where(inArray(organizationT.id, createdOrgIds));
});

describe("retention purge core", () => {
  test("deletes api calls past the cutoff, keeps recent ones, and records run + audit", async () => {
    const org = await makeOrg();
    await setPolicy(org, 30);
    await insertApiCall(org, 60); // expired
    await insertApiCall(org, 45); // expired
    await insertApiCall(org, 1);  // recent
    expect(await countApiCalls(org)).toBe(3);

    await runRetentionCycle(db, new Date(), deleteOk);

    expect(await countApiCalls(org)).toBe(1);
    const run = await latestRun(org);
    expect(run?.deletedApiCalls).toBe(2);
    expect(run?.finishedAt).not.toBeNull();
    expect(run?.error).toBeNull();
    expect(run?.apiCallCutoff).not.toBeNull();

    const audits = await db.select().from(auditLogT)
      .where(and(eq(auditLogT.organizationId, org), eq(auditLogT.action, "retention.purge")));
    expect(audits.length).toBe(1);
    expect(audits[0].actorUserId).toBeNull(); // system actor
    expect(audits[0].details).toMatchObject({ deletedApiCalls: 2 });
  });

  test("media: deletes blob and row when S3 delete succeeds", async () => {
    const org = await makeOrg();
    await setPolicy(org, 30, 30);
    await insertMedia(org, 60);
    await insertMedia(org, 45);
    await insertMedia(org, 1);

    await purgeOrganization(db, { organizationId: org, apiCallRetentionDays: 30, mediaRetentionDays: 30, updatedByUserId: null, createdAt: new Date(), updatedAt: new Date() }, new Date(), deleteOk);

    expect(await countMedia(org)).toBe(1);
    expect((await latestRun(org))?.deletedMediaObjects).toBe(2);
  });

  test("media: keeps the row and records an error when S3 delete fails (no orphaned blobs)", async () => {
    const org = await makeOrg();
    await setPolicy(org, 30, 30);
    await insertMedia(org, 60);
    await insertMedia(org, 45);

    await runRetentionCycle(db, new Date(), deleteFail);

    expect(await countMedia(org)).toBe(2); // both kept
    const run = await latestRun(org);
    expect(run?.deletedMediaObjects).toBe(0);
    expect(run?.error).toContain("S3 deletion failed");
  });

  test("keep-forever (null retention) deletes nothing and writes no audit", async () => {
    const org = await makeOrg();
    await insertApiCall(org, 9999);
    // apiCallRetentionDays null => cutoff null => nothing purged.
    await purgeOrganization(db, { organizationId: org, apiCallRetentionDays: null, mediaRetentionDays: null, updatedByUserId: null, createdAt: new Date(), updatedAt: new Date() }, new Date(), deleteOk);

    expect(await countApiCalls(org)).toBe(1);
    const audits = await db.select().from(auditLogT).where(eq(auditLogT.organizationId, org));
    expect(audits.length).toBe(0);
  });

  test("never touches usage aggregates", async () => {
    const org = await makeOrg();
    await setPolicy(org, 30);
    await db.insert(usageEventT).values({
      organizationId: org, model: "test-model", inputTokens: 5, outputTokens: 5,
      createdAt: new Date(Date.now() - 400 * DAY_MS), // far past any cutoff
    });
    await insertApiCall(org, 60);

    await runRetentionCycle(db, new Date(), deleteOk);

    const [usage] = await db.select({ n: count() }).from(usageEventT).where(eq(usageEventT.organizationId, org));
    expect(usage?.n).toBe(1); // usage_event untouched
    expect(await countApiCalls(org)).toBe(0); // api_call still purged
  });

  test("once-per-day guard: a second cycle on the same day is skipped", async () => {
    const org = await makeOrg();
    await setPolicy(org, 30);
    await insertApiCall(org, 60);
    const now = new Date();

    await runRetentionCycle(db, now, deleteOk);
    expect(await countRuns(org)).toBe(1);
    expect(await isPurgeDue(db, org, now)).toBe(false);

    await runRetentionCycle(db, now, deleteOk); // should skip
    expect(await countRuns(org)).toBe(1); // no new run row

    // A day later it is due again.
    expect(await isPurgeDue(db, org, new Date(now.getTime() + 25 * 60 * 60_000))).toBe(true);
  });
});
