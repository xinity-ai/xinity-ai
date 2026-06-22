import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  aiNodeT,
  usageEventT,
  preconfigureDB,
  eq,
} from "common-db";
import { ownerFetch, getSetupState, apiUrl } from "./api-helpers";
import { ensureE2EReady } from "../guard";
import { STORAGE_STATE, BASE_URL, type StorageState } from "../utils/test-data";

type NodeSummary = {
  id: string;
  machineName: string | null;
  online: boolean;
  models: unknown[];
  usage: { requests: number; failedRequests: number; inputTokens: number; outputTokens: number };
};
type ComputeOverview = {
  nodes: NodeSummary[];
  totals: { machinesTotal: number; requests: number; inputTokens: number };
};
type ComputeHistory = {
  bucketSeconds: number;
  series: { nodeId: string; points: { t: number; tokens: number }[] }[];
};

let db: ReturnType<ReturnType<typeof preconfigureDB>["getDB"]>;
let nodeId: string;
let orgId: string;

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

beforeAll(async () => {
  await ensureE2EReady();
  loadRootEnv();
  if (!process.env.DB_CONNECTION_URL) {
    throw new Error("DB_CONNECTION_URL not set; copy example.env to .env at the repo root");
  }
  db = preconfigureDB(process.env.DB_CONNECTION_URL).getDB();
  orgId = (await getSetupState()).orgId;

  const [node] = await db
    .insert(aiNodeT)
    .values({
      host: `compute-e2e-${randomUUID()}`,
      port: 9123,
      estCapacity: 80,
      gpuCount: 1,
      machineName: "Compute E2E Test Machine",
      gpus: [{ vendor: "nvidia", name: "NVIDIA H100 80GB HBM3", vramMb: 81559 }],
    })
    .returning();
  nodeId = node.id;

  await db.insert(usageEventT).values([
    { organizationId: orgId, model: "compute-e2e-model", nodeId, inputTokens: 100, outputTokens: 50, success: true },
    { organizationId: orgId, model: "compute-e2e-model", nodeId, inputTokens: 200, outputTokens: 70, success: true },
    { organizationId: orgId, model: "compute-e2e-model", nodeId, inputTokens: 0, outputTokens: 0, success: false },
    // Outside the default 24h range; must be excluded from range-scoped stats
    { organizationId: orgId, model: "compute-e2e-model", nodeId, inputTokens: 9999, outputTokens: 9999, success: true, createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
  ]);
});

afterAll(async () => {
  if (!db || !nodeId) return;
  await db.delete(usageEventT).where(eq(usageEventT.nodeId, nodeId));
  await db.delete(aiNodeT).where(eq(aiNodeT.id, nodeId));
});

describe("compute API", () => {
  test("overview returns the node with inventory and range-scoped usage", async () => {
    const res = await ownerFetch("/api/compute/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ComputeOverview;

    const node = body.nodes.find((n) => n.id === nodeId);
    expect(node).toBeTruthy();
    expect(node!.machineName).toBe("Compute E2E Test Machine");
    expect(node!.online).toBe(true);
    expect(node!.usage.requests).toBe(3);
    expect(node!.usage.failedRequests).toBe(1);
    expect(node!.usage.inputTokens).toBe(300);
    expect(node!.usage.outputTokens).toBe(120);

    expect(body.totals.machinesTotal).toBeGreaterThanOrEqual(1);
    expect(body.totals.requests).toBeGreaterThanOrEqual(3);
  });

  test("overview range parameter widens the window", async () => {
    const res = await ownerFetch("/api/compute/overview?rangeHours=72");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ComputeOverview;
    const node = body.nodes.find((n) => n.id === nodeId)!;
    expect(node.usage.requests).toBe(4);
    expect(node.usage.inputTokens).toBe(300 + 9999);
  });

  test("history returns bucketed tokens for the node", async () => {
    const res = await ownerFetch("/api/compute/history?rangeHours=24");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ComputeHistory;
    expect(body.bucketSeconds).toBe(1800);

    const series = body.series.find((s) => s.nodeId === nodeId);
    expect(series).toBeTruthy();
    const totalTokens = series!.points.reduce((acc, p) => acc + p.tokens, 0);
    expect(totalTokens).toBe(300 + 120);
  });

  test("unauthenticated requests are rejected", async () => {
    const res = await fetch(apiUrl("/api/compute/overview"), {
      headers: { Origin: BASE_URL },
    });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(500);
  });

  test("viewer role is denied access to the compute overview", async () => {
    const storageState = JSON.parse(readFileSync(STORAGE_STATE.viewer, "utf-8")) as StorageState;
    const cookies = storageState.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const res = await fetch(apiUrl("/api/compute/overview"), {
      headers: { "Content-Type": "application/json", Origin: BASE_URL, Cookie: cookies },
    });
    expect(res.status).toBe(403);
  });
});
