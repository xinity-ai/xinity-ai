import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  aiNodeT,
  and,
  count,
  eq,
  isNull,
  nodeMetricT,
  organizationT,
  preconfigureDB,
  sql,
  sum,
  usageEventT,
} from "common-db";
import { randomUUID } from "crypto";
import { ensureSystemReady } from "./guard";

const orgId = `org-${randomUUID()}`;
let nodeId: string;
let db: ReturnType<ReturnType<typeof preconfigureDB>["getDB"]>;

beforeAll(async () => {
  await ensureSystemReady();
  const { getDB } = preconfigureDB(process.env.DB_CONNECTION_URL!);
  db = getDB();

  await db.insert(organizationT).values({
    id: orgId,
    name: "Fleet Test Org",
    slug: `org-${randomUUID()}`,
  });

  const [node] = await db
    .insert(aiNodeT)
    .values({
      host: `fleet-test-${randomUUID()}`,
      port: 9123,
      estCapacity: 80,
      gpuCount: 1,
      machineName: "Asus Ascent GX10",
      gpus: [{ vendor: "nvidia", name: "GB10", vramMb: 131072 }],
    })
    .returning();
  nodeId = node.id;
});

afterAll(async () => {
  if (!db) return;
  if (nodeId) {
    await db.delete(aiNodeT).where(eq(aiNodeT.id, nodeId));
  }
  await db.delete(organizationT).where(eq(organizationT.id, orgId));
});

describe("fleet telemetry schema", () => {
  it("persists machine identity and heartbeat on ai_node", async () => {
    const lastSeenAt = new Date();
    await db
      .update(aiNodeT)
      .set({ lastSeenAt, totalEnergyWh: sql`${aiNodeT.totalEnergyWh} + 12.5` })
      .where(eq(aiNodeT.id, nodeId));

    const [node] = await db.select().from(aiNodeT).where(eq(aiNodeT.id, nodeId));
    expect(node.machineName).toBe("Asus Ascent GX10");
    expect(node.lastSeenAt?.getTime()).toBe(lastSeenAt.getTime());
    expect(node.totalEnergyWh).toBeCloseTo(12.5);
  });

  it("round-trips node_metric buckets and upserts on the composite key", async () => {
    const bucketStart = new Date("2026-06-10T10:00:00Z");
    const metric = {
      nodeId,
      bucketStart,
      gpuUtilizationAvg: 42.5,
      gpuUtilizationMax: 97,
      memoryUsedMb: 65536,
      powerWattsAvg: 310.4,
      energyWh: 25.9,
    };
    await db.insert(nodeMetricT).values(metric);

    // The daemon re-flushes the open bucket on shutdown; same key must update, not duplicate.
    await db
      .insert(nodeMetricT)
      .values({ ...metric, gpuUtilizationAvg: 45, energyWh: 27.1 })
      .onConflictDoUpdate({
        target: [nodeMetricT.nodeId, nodeMetricT.bucketStart],
        set: { gpuUtilizationAvg: 45, energyWh: 27.1 },
      });

    const rows = await db
      .select()
      .from(nodeMetricT)
      .where(and(eq(nodeMetricT.nodeId, nodeId), eq(nodeMetricT.bucketStart, bucketStart)));
    expect(rows).toHaveLength(1);
    expect(rows[0].gpuUtilizationAvg).toBeCloseTo(45);
    expect(rows[0].energyWh).toBeCloseTo(27.1);
    expect(rows[0].powerWattsAvg).toBeCloseTo(310.4);
  });

  it("attributes usage events to nodes and aggregates success rates", async () => {
    const baseEvent = { organizationId: orgId, model: "fleet-test-model", nodeId };
    await db.insert(usageEventT).values([
      { ...baseEvent, inputTokens: 100, outputTokens: 40 },
      { ...baseEvent, inputTokens: 200, outputTokens: 80 },
      { ...baseEvent, inputTokens: 50, outputTokens: 0, success: false },
    ]);

    const [agg] = await db
      .select({
        requests: count(),
        succeeded: count(sql`CASE WHEN ${usageEventT.success} THEN 1 END`),
        inputTokens: sum(usageEventT.inputTokens).mapWith(Number),
        outputTokens: sum(usageEventT.outputTokens).mapWith(Number),
      })
      .from(usageEventT)
      .where(eq(usageEventT.nodeId, nodeId));

    expect(agg.requests).toBe(3);
    expect(agg.succeeded).toBe(2);
    expect(agg.inputTokens).toBe(350);
    expect(agg.outputTokens).toBe(120);
  });

  it("cascades metrics on node deletion but preserves usage events", async () => {
    const [node] = await db
      .insert(aiNodeT)
      .values({ host: `fleet-cascade-${randomUUID()}`, port: 9124, estCapacity: 24 })
      .returning();
    await db.insert(nodeMetricT).values({ nodeId: node.id, bucketStart: new Date() });
    const [event] = await db
      .insert(usageEventT)
      .values({ organizationId: orgId, model: "fleet-test-model", nodeId: node.id })
      .returning();

    await db.delete(aiNodeT).where(eq(aiNodeT.id, node.id));

    const metrics = await db.select().from(nodeMetricT).where(eq(nodeMetricT.nodeId, node.id));
    expect(metrics).toHaveLength(0);
    const [orphaned] = await db
      .select()
      .from(usageEventT)
      .where(and(eq(usageEventT.id, event.id), isNull(usageEventT.nodeId)));
    expect(orphaned).toBeTruthy();
  });
});
