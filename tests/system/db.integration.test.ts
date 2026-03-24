import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { aiApiKeyT, aiApplicationT, eq, organizationT, preconfigureDB } from "common-db";
import { randomUUID } from "crypto";
import { ensureSystemReady } from "./guard";

const orgId = `org-${randomUUID()}`;
const appName = `app-${randomUUID()}`;
let appId: string;
let apiKeyId: string;
let db: ReturnType<ReturnType<typeof preconfigureDB>["getDB"]>;

beforeAll(async () => {
  await ensureSystemReady();
  const { getDB } = preconfigureDB(process.env.DB_CONNECTION_URL!);
  db = getDB();

  await db.insert(organizationT).values({
    id: orgId,
    name: "System Test Org",
    slug: `org-${randomUUID()}`,
  });

  const [app] = await db
    .insert(aiApplicationT)
    .values({
      name: appName,
      description: "System test app",
      organizationId: orgId,
    })
    .returning();
  appId = app.id;

  const [apiKey] = await db
    .insert(aiApiKeyT)
    .values({
      name: "System Test Key",
      enabled: true,
      applicationId: appId,
      organizationId: orgId,
      specifier: `sk_${randomUUID()}`,
      hash: "hash-placeholder",
    })
    .returning();
  apiKeyId = apiKey.id;
});

afterAll(async () => {
  if (!db) return;
  if (apiKeyId) {
    await db.delete(aiApiKeyT).where(eq(aiApiKeyT.id, apiKeyId));
  }
  if (appId) {
    await db.delete(aiApplicationT).where(eq(aiApplicationT.id, appId));
  }
  await db.delete(organizationT).where(eq(organizationT.id, orgId));
});

describe("common-db integration", () => {
  it("persists and retrieves API keys linked to applications and organizations", async () => {
    const [apiKey] = await db
      .select()
      .from(aiApiKeyT)
      .where(eq(aiApiKeyT.id, apiKeyId))
      .limit(1);

    expect(apiKey).toBeTruthy();
    expect(apiKey?.organizationId).toBe(orgId);
    expect(apiKey?.applicationId).toBe(appId);
    expect(apiKey?.enabled).toBe(true);
  });

  it("enforces application ownership by organization", async () => {
    const [app] = await db
      .select()
      .from(aiApplicationT)
      .where(eq(aiApplicationT.id, appId))
      .limit(1);

    expect(app).toBeTruthy();
    expect(app?.organizationId).toBe(orgId);
  });
});
