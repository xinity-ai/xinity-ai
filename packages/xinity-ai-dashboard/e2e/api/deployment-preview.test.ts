import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { aiNodeT, preconfigureDB, sql } from "common-db";
import { ownerFetch } from "./api-helpers";
import { ensureE2EReady } from "../guard";

type Preview = {
  deployable: boolean;
  reason?: string;
  replicas: { specifier: string; machines: { machineName: string; cards: number; gpuGb: number; hostGb: number }[] }[];
};

const MODEL = "apertus-v1.1-0.5b-vllm";
const GB_PER_GIB = 1.073741824;

let db: ReturnType<ReturnType<typeof preconfigureDB>["getDB"]>;
const machineName = `Preview E2E Machine ${randomUUID()}`;
let nodeId: string;

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

async function preview(body: Record<string, unknown>): Promise<Preview> {
  const res = await ownerFetch("/api/deployment/check-capacity", { method: "POST", body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return (await res.json()) as Preview;
}

beforeAll(async () => {
  await ensureE2EReady();
  loadRootEnv();
  if (!process.env.DB_CONNECTION_URL) {
    throw new Error("DB_CONNECTION_URL not set; copy example.env to .env at the repo root");
  }
  db = preconfigureDB(process.env.DB_CONNECTION_URL).getDB();
  const [node] = await db.insert(aiNodeT).values({
    host: `preview-e2e-${randomUUID()}`,
    port: 9124,
    estCapacity: 79,
    hostMemoryGb: 100,
    gpuCount: 1,
    machineName,
    driverVersions: { vllm: "0.31.0" },
    gpus: [{ vendor: "nvidia", name: "NVIDIA H100 80GB HBM3", vramMb: 81559, uuid: `GPU-${randomUUID()}` }],
  }).returning();
  nodeId = node!.id;
});

afterAll(async () => {
  if (!db || !nodeId) return;
  await db.delete(aiNodeT).where(sql`${aiNodeT.id} = ${nodeId}`);
});

describe("deployment placement preview", () => {
  test("plans a replica where the scheduler would put it, charged its engine's own memory and a host part", async () => {
    const body = await preview({ specifier: MODEL, replicas: 1 });
    expect(body.deployable).toBe(true);
    const machine = body.replicas.flatMap((replica) => replica.machines).find((candidate) => candidate.machineName === machineName);
    expect(machine).toBeTruthy();
    expect(machine!.cards).toBe(1);
    expect(machine!.gpuGb).toBeGreaterThan(0.88 + 2.5 * GB_PER_GIB);
    expect(machine!.hostGb).toBeCloseTo(5.5 * GB_PER_GIB);
  });

  test("names why a replica does not fit, and still shows the ones that do", async () => {
    const liveNodes = await db.select({ driverVersions: aiNodeT.driverVersions }).from(aiNodeT)
      .where(sql`${aiNodeT.available} AND ${aiNodeT.deletedAt} IS NULL`);
    const vllmNodes = liveNodes.filter((node) => node.driverVersions.vllm !== undefined).length;
    const body = await preview({ specifier: MODEL, replicas: vllmNodes + 1 });
    expect(body.deployable).toBe(false);
    expect(body.reason).toBe(`"${MODEL}" does not fit in the free memory`);
    expect(body.replicas.some((replica) => replica.machines.some((candidate) => candidate.machineName === machineName))).toBe(true);
  });

  test("refuses a machine whose reported host memory cannot take the host part", async () => {
    await db.update(aiNodeT).set({ hostMemoryGb: 1 }).where(sql`${aiNodeT.id} = ${nodeId}`);
    try {
      const body = await preview({ specifier: MODEL, replicas: 1 });
      expect(body.replicas.some((replica) => replica.machines.some((candidate) => candidate.machineName === machineName))).toBe(false);
    } finally {
      await db.update(aiNodeT).set({ hostMemoryGb: 100 }).where(sql`${aiNodeT.id} = ${nodeId}`);
    }
  });
});
