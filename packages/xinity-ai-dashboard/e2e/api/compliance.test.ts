import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  aiApiKeyT,
  auditLogT,
  retentionPolicyT,
  preconfigureDB,
  and,
  eq,
  gte,
  inArray,
} from "common-db";
import { ownerFetch, getSetupState, apiUrl } from "./api-helpers";
import { ensureE2EReady } from "../guard";
import { STORAGE_STATE, BASE_URL, type StorageState } from "../utils/test-data";

let db: ReturnType<ReturnType<typeof preconfigureDB>["getDB"]>;
let orgId: string;
let testStart: Date;
let createdApiKeyId: string | null = null;

function loadRootEnv() {
  if (process.env.DB_CONNECTION_URL) return;
  const envPath = join(import.meta.dir, "../../../../.env");
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

async function findAuditEntries(action: string) {
  return db
    .select()
    .from(auditLogT)
    .where(and(
      eq(auditLogT.organizationId, orgId),
      eq(auditLogT.action, action),
      gte(auditLogT.createdAt, testStart),
    ));
}

beforeAll(async () => {
  await ensureE2EReady();
  loadRootEnv();
  if (!process.env.DB_CONNECTION_URL) {
    throw new Error("DB_CONNECTION_URL not set; copy example.env to .env at the repo root");
  }
  db = preconfigureDB(process.env.DB_CONNECTION_URL).getDB();
  orgId = (await getSetupState()).orgId;
  testStart = new Date();
});

afterAll(async () => {
  if (!db || !orgId) return;
  await db.delete(auditLogT).where(and(
    eq(auditLogT.organizationId, orgId),
    gte(auditLogT.createdAt, testStart),
    inArray(auditLogT.action, ["retention-policy.update", "apiKey.create", "apiKey.delete"]),
  ));
  await db.delete(retentionPolicyT).where(eq(retentionPolicyT.organizationId, orgId));
  if (createdApiKeyId) {
    await db.delete(aiApiKeyT).where(eq(aiApiKeyT.id, createdApiKeyId));
  }
});

describe("compliance API", () => {
  test("retention policy round-trips and is audit-logged", async () => {
    const putRes = await ownerFetch("/api/compliance/retention-policy", {
      method: "PUT",
      body: JSON.stringify({ apiCallRetentionDays: 90, mediaRetentionDays: null }),
    });
    expect(putRes.status).toBe(200);

    const getRes = await ownerFetch("/api/compliance/retention-policy");
    expect(getRes.status).toBe(200);
    const policy = (await getRes.json()) as { apiCallRetentionDays: number; mediaRetentionDays: number | null };
    expect(policy.apiCallRetentionDays).toBe(90);
    expect(policy.mediaRetentionDays).toBeNull();

    const entries = await findAuditEntries("retention-policy.update");
    expect(entries.length).toBe(1);
    expect(entries[0].actorEmail).toBeTruthy();
    expect(entries[0].details).toMatchObject({ apiCallRetentionDays: 90 });
  });

  test("API key lifecycle writes audit entries with the acting user", async () => {
    const createRes = await ownerFetch("/api/api-key/", {
      method: "POST",
      body: JSON.stringify({ name: "compliance-e2e-key", enabled: true }),
    });
    expect(createRes.status).toBe(200);

    const created = await findAuditEntries("apiKey.create");
    expect(created.length).toBe(1);
    expect(created[0].actorUserId).toBeTruthy();
    expect(created[0].actorEmail).toBeTruthy();
    expect(created[0].details).toMatchObject({ name: "compliance-e2e-key" });
    // The audit entry must never contain the key hash or full key material.
    expect(JSON.stringify(created[0].details)).not.toContain("hash");
    createdApiKeyId = created[0].resourceId;

    const deleteRes = await ownerFetch(`/api/api-key/${createdApiKeyId}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const deleted = await findAuditEntries("apiKey.delete");
    expect(deleted.length).toBe(1);
    expect(deleted[0].resourceId).toBe(createdApiKeyId);
  });

  test("audit log read is license-gated (free tier gets 403)", async () => {
    const res = await ownerFetch("/api/compliance/audit-log");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toContain("license");
  });

  test("viewer role cannot read or change the retention policy", async () => {
    const storageState = JSON.parse(readFileSync(STORAGE_STATE.viewer, "utf-8")) as StorageState;
    const cookies = storageState.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const headers = { "Content-Type": "application/json", Origin: BASE_URL, Cookie: cookies };

    const readRes = await fetch(apiUrl("/api/compliance/retention-policy"), { headers });
    expect(readRes.status).toBe(403);

    const writeRes = await fetch(apiUrl("/api/compliance/retention-policy"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ apiCallRetentionDays: 1, mediaRetentionDays: null }),
    });
    expect(writeRes.status).toBe(403);
  });

  test("unauthenticated requests are rejected", async () => {
    const res = await fetch(apiUrl("/api/compliance/retention-policy"), {
      headers: { Origin: BASE_URL },
    });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(500);
  });
});
