import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { aiApiKeyT, aiApplicationT, sql, organizationT, preconfigureDB, usageEventT, usageSummaryT } from "common-db";
import { randomUUID } from "node:crypto";
import { ensureSystemReady } from "./guard";
import { rollupUsageEvents, dailyUsage, topApplications } from "../../packages/xinity-ai-dashboard/src/lib/server/lib/calls/usage-queries";

const orgId = `org-${randomUUID()}`;
let appId: string;
let apiKeyId: string;
let db: ReturnType<ReturnType<typeof preconfigureDB>["getDB"]>;

const DAY_MS = 24 * 60 * 60 * 1000;

function usageRow(model: string, success: boolean, inputTokens: number, outputTokens: number, createdAt: Date) {
  return {
    organizationId: orgId,
    applicationId: appId,
    apiKeyId,
    model,
    inputTokens,
    outputTokens,
    duration: 100,
    logged: success,
    success,
    createdAt,
  };
}

function summaryFor(model: string) {
  return db.select().from(usageSummaryT)
    .where(sql`${usageSummaryT.organizationId} = ${orgId} AND ${usageSummaryT.model} = ${model}`);
}

beforeAll(async () => {
  await ensureSystemReady();
  const { getDB } = preconfigureDB(process.env.DB_CONNECTION_URL!);
  db = getDB();

  await db.insert(organizationT).values({ id: orgId, name: "Usage Query Test Org", slug: `org-${randomUUID()}` });
  const [app] = await db.insert(aiApplicationT)
    .values({ name: `app-${randomUUID()}`, description: "Usage query test app", organizationId: orgId })
    .returning();
  appId = app!.id;
  const [apiKey] = await db.insert(aiApiKeyT)
    .values({
      name: "Usage Query Test Key",
      enabled: true,
      applicationId: appId,
      organizationId: orgId,
      specifier: `sk_${randomUUID()}`,
      hash: "hash-placeholder",
    })
    .returning();
  apiKeyId = apiKey!.id;

  // Each case has its own model, so ON CONFLICT keeps their summary rows apart.
  const old = new Date(Date.now() - 31 * DAY_MS);
  const today = new Date();
  await db.insert(usageEventT).values([
    usageRow("model-a", true, 100, 10, old),
    usageRow("model-a", false, 50, 5, old),
    usageRow("model-b", false, 50, 5, old),
    usageRow("model-c", true, 100, 10, today),
    usageRow("model-c", false, 50, 5, today),
  ]);

  await rollupUsageEvents(db, orgId);
});

afterAll(async () => {
  if (!db) return;
  await db.delete(usageSummaryT).where(sql`${usageSummaryT.organizationId} = ${orgId}`);
  await db.delete(usageEventT).where(sql`${usageEventT.organizationId} = ${orgId}`);
  if (apiKeyId) {
    await db.delete(aiApiKeyT).where(sql`${aiApiKeyT.id} = ${apiKeyId}`);
  }
  if (appId) {
    await db.delete(aiApplicationT).where(sql`${aiApplicationT.id} = ${appId}`);
  }
  await db.delete(organizationT).where(sql`${organizationT.id} = ${orgId}`);
});

describe("usage queries", () => {
  it("rollup counts only successful calls but sums the tokens of every row", async () => {
    const summary = await summaryFor("model-a");
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ totalCalls: 1, loggedCalls: 1, inputTokens: 150, outputTokens: 15 });

    const remaining = await db.select().from(usageEventT)
      .where(sql`${usageEventT.organizationId} = ${orgId} AND ${usageEventT.model} = 'model-a'`);
    expect(remaining).toHaveLength(0);
  });

  it("rollup keeps the tokens of a group with only failed calls", async () => {
    const summary = await summaryFor("model-b");
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ totalCalls: 0, inputTokens: 50, outputTokens: 5 });
  });

  it("daily usage counts only successful calls but sums the tokens of every row", async () => {
    const days = await dailyUsage(db, orgId);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ totalCalls: 1, loggedCalls: 1, inputTokens: 150, outputTokens: 15 });
  });

  it("top applications count only successful calls but sum the tokens of every row", async () => {
    const apps = await topApplications(db, orgId);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ applicationId: appId, totalCalls: 1, totalTokens: 165 });
  });
});
